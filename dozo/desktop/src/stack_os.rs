//! Starting and stopping the local server's processes: the part that differs per system.
//!
//! Unix: each process leads its own process group, so a stop reaches what it started too. On
//! Linux each one is also told to end when the app ends, however it ends (`PR_SET_PDEATHSIG`),
//! and inherits the folder's lock, so no second app starts a server beside what is left. Not on
//! macOS: nothing ends its processes with a crashed app yet, and an inherited lock would then
//! keep every later start out.
//! The kernel sends that signal when the thread that started the process ends, not the process:
//! every start therefore happens on one thread that lives as long as the app (`spawn`).
//! Everywhere else nothing ends them with a crashed app, so each start also leaves its pid in
//! `run/` and the next start ends what is still running from an earlier one (`leftovers`).
//! Windows: each process runs in a job object of its own, which ends it with what it started, and
//! with the app however the app ends (`stack_windows.rs`).

use std::fs::File;
use std::io;
use std::sync::{Mutex, OnceLock, mpsc};

use tokio::process::{Child, Command};
use tokio::runtime::Handle;
use tokio::sync::oneshot;

#[cfg(windows)]
#[path = "stack_windows.rs"]
mod windows;

/// How a process is asked to stop: Node takes TERM; Postgres takes INT, its fast shutdown.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stop {
    Terminate,
    Interrupt,
}

/// Tests that stand in for a system without `PR_SET_PDEATHSIG` (macOS) turn it off, and the lock
/// that goes with it.
#[cfg(all(test, unix))]
pub static AS_WITHOUT_PDEATHSIG: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Sets up `command` as described above. `lock` is the folder's lock file.
#[cfg(target_os = "linux")]
pub fn prepare(command: &mut Command, stop: Stop, lock: Option<&File>) {
    use std::os::fd::AsRawFd;
    command.process_group(0);
    #[cfg(test)]
    if AS_WITHOUT_PDEATHSIG.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let lock = lock.map(AsRawFd::as_raw_fd);
    // With the app gone there is nobody to wait for a graceful stop, and Node may not end on one
    // TERM (the worker drains first): it is killed. Postgres gets its fast shutdown, which ends
    // its own processes.
    let signal = match stop {
        Stop::Terminate => libc::SIGKILL,
        Stop::Interrupt => libc::SIGINT,
    };
    let app = std::process::id() as libc::pid_t;
    // SAFETY: between fork and exec only async-signal-safe calls (prctl, getppid, fcntl).
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, signal) != 0 {
                return Err(io::Error::last_os_error());
            }
            // The app ended before the line above ran: nothing will send the signal.
            if libc::getppid() != app {
                return Err(io::Error::other("the app has ended"));
            }
            if let Some(fd) = lock {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn prepare(command: &mut Command, _stop: Stop, _lock: Option<&File>) {
    command.process_group(0);
}

#[cfg(windows)]
pub fn prepare(command: &mut Command, _stop: Stop, _lock: Option<&File>) {
    command.creation_flags(windows::CREATION_FLAGS);
}

/// What `spawn` does with a process it started: on Windows it goes into its job, then runs.
#[cfg(unix)]
fn started(child: Child) -> io::Result<Child> {
    Ok(child)
}

#[cfg(windows)]
fn started(mut child: Child) -> io::Result<Child> {
    windows::contain(&mut child).map(|()| child)
}

/// Asks the process (and its group) to stop.
#[cfg(unix)]
pub fn ask_to_stop(child: &mut Child, stop: Stop) {
    let signal = match stop {
        Stop::Terminate => libc::SIGTERM,
        Stop::Interrupt => libc::SIGINT,
    };
    signal_group(child, signal);
}

#[cfg(windows)]
pub fn ask_to_stop(child: &mut Child, _stop: Stop) {
    windows::end(child);
}

/// Ends the process (and its group) at once.
#[cfg(unix)]
pub fn kill(child: &mut Child) {
    signal_group(child, libc::SIGKILL);
    let _ = child.start_kill();
}

#[cfg(windows)]
pub fn kill(child: &mut Child) {
    windows::end(child);
}

#[cfg(unix)]
fn signal_group(child: &Child, signal: libc::c_int) {
    if let Some(pid) = child.id() {
        // SAFETY: a plain kill(2) on the group this process leads.
        unsafe {
            libc::kill(-(pid as libc::pid_t), signal);
        }
    }
}

/// The program a running process was started from, when it can be told: on Linux its
/// executable, elsewhere its whole command line, which starts with it (the server's processes
/// are started by absolute path; the path may hold spaces). `None` when it is not running.
#[cfg(target_os = "linux")]
pub fn program_of(pid: u32) -> Option<String> {
    let program = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    Some(program.to_string_lossy().into_owned())
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn program_of(pid: u32) -> Option<String> {
    let out = std::process::Command::new("/bin/ps")
        // `-ww`: the whole command line, also with no terminal to size it to (opened from Finder),
        // where it is otherwise cut at about 80 columns.
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (!line.is_empty()).then_some(line)
}

#[cfg(windows)]
pub fn program_of(_pid: u32) -> Option<String> {
    None
}

/// Ends a process left from an earlier start, with its process group: asked first, then killed
/// after `grace`. True when it is gone.
#[cfg(unix)]
pub fn end_leftover(pid: u32, grace: std::time::Duration) -> bool {
    let pid = pid as libc::pid_t;
    // SAFETY: plain kill(2) calls on a group the process leads, and a check with signal 0.
    let alive = || unsafe { libc::kill(pid, 0) == 0 };
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
        libc::kill(pid, libc::SIGTERM);
    }
    let deadline = std::time::Instant::now() + grace;
    while alive() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
        libc::kill(pid, libc::SIGKILL);
    }
    std::thread::sleep(std::time::Duration::from_millis(100));
    !alive()
}

#[cfg(windows)]
pub fn end_leftover(_pid: u32, _grace: std::time::Duration) -> bool {
    true
}

/// Makes the link `at` to `to`, which `target` names from the link's folder
/// (`stack_fetch::make_links`): a symbolic link; on Windows a junction to a folder, or a copy of
/// a file.
#[cfg(unix)]
pub fn make_link(
    at: &std::path::Path,
    _to: &std::path::Path,
    target: &std::path::Path,
) -> io::Result<()> {
    std::os::unix::fs::symlink(target, at)
}

#[cfg(windows)]
pub fn make_link(
    at: &std::path::Path,
    to: &std::path::Path,
    _target: &std::path::Path,
) -> io::Result<()> {
    if to.is_dir() {
        windows::junction(at, to)
    } else {
        std::fs::copy(to, at).map(drop)
    }
}

type Request = (Command, Handle, oneshot::Sender<io::Result<Child>>);

/// Starts `command` on the one thread that starts them all, in the caller's runtime.
pub async fn spawn(command: Command) -> io::Result<Child> {
    static STARTER: OnceLock<Mutex<mpsc::Sender<Request>>> = OnceLock::new();
    let starter = STARTER.get_or_init(|| {
        let (send, receive) = mpsc::channel::<Request>();
        std::thread::Builder::new()
            .name("dozo-server-starter".into())
            .spawn(move || {
                for (mut command, runtime, answer) in receive {
                    let _inside = runtime.enter();
                    let _ = answer.send(command.spawn().and_then(started));
                }
            })
            .expect("a thread for starting the server's processes");
        Mutex::new(send)
    });
    let (answer, started) = oneshot::channel();
    starter
        .lock()
        .unwrap()
        .send((command, Handle::current(), answer))
        .map_err(|_| io::Error::other("the starter thread is gone"))?;
    started
        .await
        .map_err(|_| io::Error::other("the starter thread is gone"))?
}
