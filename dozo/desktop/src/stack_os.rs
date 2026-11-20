//! Starting and stopping the local server's processes: the part that differs per system.
//!
//! Unix: each process leads its own process group, so a stop reaches what it started too. On
//! Linux each one is also told to end when the app ends, however it ends (`PR_SET_PDEATHSIG`),
//! and inherits the folder's lock, so no second app starts a server beside what is left.
//! The kernel sends that signal when the thread that started the process ends, not the process:
//! every start therefore happens on one thread that lives as long as the app (`spawn`).
//! Windows: compiled, not run yet; a stop ends the process itself only (a job object that ends
//! the whole tree with the app comes with the Windows server).

use std::fs::File;
use std::io;
use std::sync::{Mutex, OnceLock, mpsc};

use tokio::process::{Child, Command};
use tokio::runtime::Handle;
use tokio::sync::oneshot;

/// How a process is asked to stop: Node takes TERM; Postgres takes INT, its fast shutdown.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stop {
    Terminate,
    Interrupt,
}

/// Sets up `command` as described above. `lock` is the folder's lock file.
#[cfg(unix)]
pub fn prepare(command: &mut Command, stop: Stop, lock: Option<&File>) {
    use std::os::fd::AsRawFd;
    command.process_group(0);
    let lock = lock.map(AsRawFd::as_raw_fd);
    #[cfg(target_os = "linux")]
    let (signal, app) = (
        match stop {
            Stop::Terminate => libc::SIGTERM,
            Stop::Interrupt => libc::SIGINT,
        },
        std::process::id() as libc::pid_t,
    );
    #[cfg(not(target_os = "linux"))]
    let _ = stop;
    // SAFETY: between fork and exec only async-signal-safe calls (prctl, getppid, fcntl).
    unsafe {
        command.pre_exec(move || {
            #[cfg(target_os = "linux")]
            {
                if libc::prctl(libc::PR_SET_PDEATHSIG, signal) != 0 {
                    return Err(io::Error::last_os_error());
                }
                // The app ended before the line above ran: nothing will send the signal.
                if libc::getppid() != app {
                    return Err(io::Error::other("the app has ended"));
                }
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

#[cfg(windows)]
pub fn prepare(command: &mut Command, _stop: Stop, _lock: Option<&File>) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
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
    let _ = child.start_kill();
}

/// Ends the process (and its group) at once.
#[cfg(unix)]
pub fn kill(child: &mut Child) {
    signal_group(child, libc::SIGKILL);
    let _ = child.start_kill();
}

#[cfg(windows)]
pub fn kill(child: &mut Child) {
    let _ = child.start_kill();
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
                    let _ = answer.send(command.spawn());
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
