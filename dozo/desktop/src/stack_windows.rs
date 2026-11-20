//! The server on this computer, the part only Windows has (`stack_os.rs` calls it).
//!
//! Each process runs in a job object of its own, set to end everything in it when its last handle
//! closes. Only the app holds that handle, so when the app ends, however it ends, the system ends
//! every process of the server; and a stop ends a process with what it started, as a process group
//! does on Unix. A process starts suspended and runs only once it is in its job, so nothing it
//! starts escapes it. Postgres, started by `pg_ctl` (`stack.rs`), is in the job of that `pg_ctl`.
//!
//! Also the junctions a bundle built on Windows lists (`stack_fetch::LINKS`): a symbolic link
//! needs a privilege most people do not have; a junction does not.

use std::collections::HashMap;
use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use tokio::process::Child;
use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, OPEN_EXISTING,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

/// Creation flags for every process of the server: no console window, and held until it is in
/// its job (`contain`).
pub const CREATION_FLAGS: u32 = windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
    | windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

/// A handle the app owns, closed when dropped.
struct Owned(HANDLE);

// SAFETY: a kernel handle, usable from any thread.
unsafe impl Send for Owned {}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the handle is ours and closed once.
        unsafe { CloseHandle(self.0) };
    }
}

/// The job of each running process, by its pid.
static JOBS: LazyLock<Mutex<HashMap<u32, Owned>>> = LazyLock::new(Mutex::default);

/// Puts a process started with `CREATION_FLAGS` in a job of its own and lets it run. On an error
/// the process is ended.
pub fn contain(child: &mut Child) -> io::Result<()> {
    let result = job_for(child);
    if result.is_err() {
        let _ = child.start_kill();
    }
    result
}

fn job_for(child: &Child) -> io::Result<()> {
    let (Some(pid), Some(process)) = (child.id(), child.raw_handle()) else {
        return Err(io::Error::other("the process has already ended"));
    };
    // SAFETY: plain calls on a job made here and on the process's own handle; the limits are a
    // whole structure of the size given.
    let job = unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Owned(job);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast::<c_void>(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if set == 0 || AssignProcessToJobObject(job.0, process as HANDLE) == 0 {
            return Err(io::Error::last_os_error());
        }
        job
    };
    resume(pid)?;
    let mut jobs = JOBS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Jobs whose processes all ended on their own (a restart): nothing left in them to end.
    jobs.retain(|_, job| active(job) > 0);
    jobs.insert(pid, job);
    Ok(())
}

/// Lets every thread of a suspended process run: a new one has one.
fn resume(pid: u32) -> io::Result<()> {
    // SAFETY: a snapshot of the system's threads, read entry by entry into a structure of the
    // size it says, and a handle to each of this process's threads, closed after use.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = Owned(snapshot);
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut resumed = 0;
        let mut more = Thread32First(snapshot.0, &mut entry) != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    let thread = Owned(thread);
                    if ResumeThread(thread.0) != u32::MAX {
                        resumed += 1;
                    }
                }
            }
            more = Thread32Next(snapshot.0, &mut entry) != 0;
        }
        if resumed == 0 {
            return Err(io::Error::other(format!("could not start process {pid}")));
        }
    }
    Ok(())
}

/// How many processes are still in a job.
fn active(job: &Owned) -> u32 {
    let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    // SAFETY: the job is ours; the answer is written into a whole structure of the size given.
    let asked = unsafe {
        QueryInformationJobObject(
            job.0,
            JobObjectBasicAccountingInformation,
            (&raw mut info).cast::<c_void>(),
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            std::ptr::null_mut(),
        )
    };
    if asked == 0 { 1 } else { info.ActiveProcesses }
}

/// Ends the process with everything in its job. Windows has no signal to ask a process to stop
/// that a process without a console hears, so a stop ends it at once; what has to stop cleanly,
/// Postgres, is stopped by `pg_ctl` instead (`stack.rs`).
pub fn end(child: &mut Child) {
    let job = child.id().and_then(|pid| {
        JOBS.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&pid)
    });
    if let Some(job) = job {
        // SAFETY: a job made by `contain`, ended once and then closed.
        unsafe { TerminateJobObject(job.0, 1) };
    }
    let _ = child.start_kill();
}

/// Makes `link` a junction to the folder `target` (both absolute).
pub fn junction(link: &Path, target: &Path) -> io::Result<()> {
    std::fs::create_dir(link)?;
    let made = mount_point(link, target);
    if made.is_err() {
        let _ = std::fs::remove_dir(link);
    }
    made
}

fn mount_point(link: &Path, target: &Path) -> io::Result<()> {
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    let print: Vec<u16> = plain(target).encode_wide().collect();
    let substitute: Vec<u16> = r"\??\"
        .encode_utf16()
        .chain(print.iter().copied())
        .collect();
    let names = (substitute.len() + 1 + print.len() + 1) * 2;
    let field = |value: usize| {
        u16::try_from(value).map_err(|_| io::Error::other("the junction's target is too long"))
    };
    // The reparse header, then the mount point's offsets and lengths in bytes, then both names,
    // each ending with a NUL.
    let mut buffer = Vec::with_capacity(16 + names);
    buffer.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend(field(8 + names)?.to_le_bytes());
    buffer.extend(0u16.to_le_bytes());
    buffer.extend(0u16.to_le_bytes());
    buffer.extend(field(substitute.len() * 2)?.to_le_bytes());
    buffer.extend(field((substitute.len() + 1) * 2)?.to_le_bytes());
    buffer.extend(field(print.len() * 2)?.to_le_bytes());
    for name in [&substitute, &print] {
        buffer.extend(name.iter().chain([&0]).flat_map(|unit| unit.to_le_bytes()));
    }
    let path: Vec<u16> = verbatim(link).chain([0]).collect();
    // SAFETY: the folder is opened as itself (not what it points at) and closed after; the buffer
    // is a whole reparse structure of the length given.
    unsafe {
        let folder = CreateFileW(
            path.as_ptr(),
            GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        );
        if folder == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let folder = Owned(folder);
        let mut returned = 0u32;
        let set = DeviceIoControl(
            folder.0,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast::<c_void>(),
            buffer.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        );
        if set == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// An absolute path without the `\\?\` prefix, with backslashes.
fn plain(path: &Path) -> std::ffi::OsString {
    let text = path.as_os_str().to_string_lossy().replace('/', "\\");
    text.strip_prefix(r"\\?\").unwrap_or(&text).into()
}

/// The path with the `\\?\` prefix, which lifts the 260-character limit (not for a network path).
fn verbatim(path: &Path) -> impl Iterator<Item = u16> {
    let plain = plain(path);
    let prefix = if plain.to_string_lossy().starts_with(r"\\") {
        ""
    } else {
        r"\\?\"
    };
    prefix
        .encode_utf16()
        .chain(plain.encode_wide().collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stack_fetch::tests::scratch;
    use std::time::Duration;
    use tokio::process::Command;

    /// A command started as the server's are: a `cmd` that starts a second, long one of its own.
    async fn started(dir: &Path) -> (Child, std::path::PathBuf) {
        let marker = dir.join("child-started");
        let mut command = Command::new("cmd");
        command
            .args(["/D", "/C"])
            .raw_arg(format!(
                "\"echo x> \"{}\" & ping -n 300 127.0.0.1 > NUL\"",
                marker.display()
            ))
            .creation_flags(CREATION_FLAGS)
            .kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        contain(&mut child).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the process never ran: it was not resumed");
        (child, marker)
    }

    fn pings() -> usize {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq PING.EXE", "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|line| line.to_ascii_uppercase().starts_with("PING.EXE"))
            .count()
    }

    #[tokio::test]
    async fn a_contained_process_runs_and_ends_with_what_it_started() {
        let dir = scratch("job");
        let before = pings();
        let (mut child, _) = started(&dir).await;
        assert_eq!(pings(), before + 1, "the inner command runs");
        end(&mut child);
        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(pings(), before, "the inner command ended with it");
    }

    #[test]
    fn a_junction_reaches_its_folder_and_goes_with_its_parent_alone() {
        let dir = scratch("junction");
        let target = dir.join("store").join("pkg");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("index.js"), "x").unwrap();
        // Deep enough that the whole path is past 260 characters.
        let deep = (0..12).fold(dir.join("links"), |path, n| {
            path.join(format!("folder-with-a-long-name-{n:02}"))
        });
        std::fs::create_dir_all(&deep).unwrap();
        let link = deep.join("pkg");
        assert!(link.as_os_str().len() > 260);
        junction(&link, &target).unwrap();
        assert_eq!(std::fs::read_to_string(link.join("index.js")).unwrap(), "x");
        std::fs::remove_dir_all(dir.join("links")).unwrap();
        assert!(
            target.join("index.js").exists(),
            "removing the link kept its target"
        );
    }
}
