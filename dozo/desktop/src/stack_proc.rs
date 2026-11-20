//! Runs the local server's processes: one-shot steps to completion, and the long-running ones
//! kept up, each started again after an unexpected exit with a growing wait. Their output goes to
//! one log file each, cut to a fresh file past a size. Stopping goes in reverse order of start,
//! each asked first and ended after its grace period. Tested below with stand-in processes.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::stack_os::{self, Stop};

/// One process: what to run, how, and where its output goes.
#[derive(Clone, Debug)]
pub struct Spec {
    pub name: &'static str,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    /// The whole environment: nothing of the app's own is passed on.
    pub env: Vec<(String, String)>,
    pub stop: Stop,
    pub grace: Duration,
    /// Told each line the process writes to stdout, besides its log.
    pub on_line: Option<OnLine>,
}

/// What hears a process's stdout, a line at a time (with its newline).
#[derive(Clone)]
pub struct OnLine(pub Arc<LineFn>);

pub type LineFn = dyn Fn(&[u8]) + Send + Sync;

impl std::fmt::Debug for OnLine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OnLine")
    }
}

/// A log file cut to a fresh one past `max` bytes, keeping one older file (`.1`).
pub struct Log {
    path: PathBuf,
    max: u64,
    file: Option<(File, u64)>,
}

impl Log {
    pub fn new(path: PathBuf, max: u64) -> Arc<Mutex<Log>> {
        Arc::new(Mutex::new(Log {
            path,
            max,
            file: None,
        }))
    }

    pub fn write(&mut self, line: &[u8]) {
        if self
            .file
            .as_ref()
            .is_some_and(|(_, size)| *size >= self.max)
        {
            self.file = None;
            let mut older = self.path.as_os_str().to_owned();
            older.push(".1");
            let _ = fs::rename(&self.path, older);
        }
        if self.file.is_none() {
            let opened = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path);
            if let Ok(file) = opened {
                let size = file.metadata().map_or(0, |meta| meta.len());
                self.file = Some((file, size));
            }
        }
        if let Some((file, size)) = &mut self.file
            && file.write_all(line).is_ok()
        {
            *size += line.len() as u64;
        }
    }
}

/// What every start shares: the logs folder, the folder's lock (inherited, `stack_os.rs`) and
/// the waits between restarts.
pub struct Launch {
    pub logs: PathBuf,
    /// Where each started process leaves its pid (`run/<name>.pid`), for `end_leftovers`.
    pub run: PathBuf,
    pub lock: Option<Arc<File>>,
    pub backoff: Backoff,
    /// Size at which a log file is cut.
    pub log_max: u64,
    /// The manager's own log: starts, exits and restarts.
    pub events: Arc<Mutex<Log>>,
}

impl Launch {
    /// The same, for processes that must not hold the folder's lock.
    pub fn without_lock(&self) -> Launch {
        Launch {
            logs: self.logs.clone(),
            run: self.run.clone(),
            lock: None,
            backoff: self.backoff.clone(),
            log_max: self.log_max,
            events: self.events.clone(),
        }
    }

    pub fn note(&self, line: &str) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        self.events
            .lock()
            .unwrap()
            .write(format!("{stamp} {line}\n").as_bytes());
    }

    /// Starts `spec`; the task returned ends once its stdout has been read to the end.
    async fn spawn(&self, spec: &Spec) -> std::io::Result<(Child, JoinHandle<()>)> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(spec.env.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        stack_os::prepare(&mut command, spec.stop, self.lock.as_deref());
        let mut child = stack_os::spawn(command).await?;
        if let Some(pid) = child.id() {
            let _ = fs::write(self.run.join(format!("{}.pid", spec.name)), pid.to_string());
        }
        let log = Log::new(self.logs.join(format!("{}.log", spec.name)), self.log_max);
        let out = child.stdout.take().expect("piped");
        let stdout = tokio::spawn(copy_lines(out, log.clone(), spec.on_line.clone()));
        if let Some(err) = child.stderr.take() {
            tokio::spawn(copy_lines(err, log, None));
        }
        self.note(&format!(
            "{} started (pid {})",
            spec.name,
            child.id().unwrap_or(0)
        ));
        Ok((child, stdout))
    }
}

/// Copies a process's output into its log line by line, and keeps reading whatever happens to
/// the file: a pipe nobody reads would block the process.
async fn copy_lines(stream: impl AsyncRead + Unpin, log: Arc<Mutex<Log>>, on_line: Option<OnLine>) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line).await.unwrap_or(0) > 0 {
        log.lock().unwrap().write(&line);
        if let Some(on_line) = &on_line {
            (on_line.0)(&line);
        }
        line.clear();
    }
}

/// Waits between restarts: `first`, doubled after each, at most `max`, and back to `first` once
/// a process stayed up for `stable`.
#[derive(Clone, Debug)]
pub struct Backoff {
    pub first: Duration,
    pub max: Duration,
    pub stable: Duration,
    next: Duration,
}

impl Backoff {
    pub fn new(first: Duration, max: Duration, stable: Duration) -> Backoff {
        Backoff {
            first,
            max,
            stable,
            next: first,
        }
    }

    /// The wait before the next start, after a run that lasted `ran`.
    pub fn after(&mut self, ran: Duration) -> Duration {
        if ran >= self.stable {
            self.next = self.first;
        }
        let wait = self.next;
        self.next = (self.next * 2).min(self.max);
        wait
    }
}

/// Runs a step to completion within `limit`; its exit status must be success.
pub async fn run_once(spec: &Spec, launch: &Launch, limit: Duration) -> Result<(), String> {
    let (child, stdout) = launch
        .spawn(spec)
        .await
        .map_err(|error| format!("{} did not start: {error}", spec.name))?;
    let mut step = Unfinished(Some(child));
    let child = step.0.as_mut().expect("just started");
    let status = match tokio::time::timeout(limit, child.wait()).await {
        Ok(status) => status.map_err(|error| error.to_string())?,
        Err(_) => {
            stack_os::kill(child);
            let _ = child.wait().await;
            return Err(format!("{} took longer than {limit:?}", spec.name));
        }
    };
    step.0 = None;
    // What it wrote last is heard before the step counts as done.
    let _ = tokio::time::timeout(Duration::from_secs(5), stdout).await;
    launch.note(&format!("{} exited ({status})", spec.name));
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} failed ({status})", spec.name))
    }
}

/// Runs a step like `run_once` and returns its stdout; a failure carries it too.
pub async fn output(spec: &Spec, launch: &Launch, limit: Duration) -> Result<String, String> {
    let heard = Arc::new(Mutex::new(Vec::new()));
    let mut spec = spec.clone();
    spec.on_line = Some(OnLine(Arc::new({
        let heard = heard.clone();
        move |line| heard.lock().unwrap().extend_from_slice(line)
    })));
    let result = run_once(&spec, launch, limit).await;
    let text = String::from_utf8_lossy(&heard.lock().unwrap()).into_owned();
    result
        .map(|()| text.clone())
        .map_err(|why| format!("{why}: {}", text.trim()))
}

/// A step whose wait was cancelled (the start was stopped) ends with what it started.
struct Unfinished(Option<Child>);

impl Drop for Unfinished {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            stack_os::kill(child);
        }
    }
}

struct Kept {
    stop: watch::Sender<bool>,
    task: JoinHandle<bool>,
}

/// The long-running processes, in the order they were started.
#[derive(Default)]
pub struct Supervisor {
    kept: Vec<Kept>,
}

impl Supervisor {
    /// Starts `spec` and keeps it running until `stop_all`. Fails if the first start fails.
    pub async fn keep(&mut self, spec: Spec, launch: Arc<Launch>) -> std::io::Result<()> {
        let (child, _) = launch.spawn(&spec).await?;
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(keep_running(spec, launch, child, stopped));
        self.kept.push(Kept { stop, task });
        Ok(())
    }

    /// Stops every process: all but the first started together, then the first (Postgres, which
    /// the others use), so the longest grace sets the wait rather than their sum. True when each
    /// stopped within its grace period; one that had to be killed makes it false.
    pub async fn stop_all(&mut self) -> bool {
        let mut kept = std::mem::take(&mut self.kept);
        let first = (!kept.is_empty()).then(|| kept.remove(0));
        for each in &kept {
            let _ = each.stop.send(true);
        }
        let mut clean = true;
        for each in kept.into_iter().chain(first) {
            let _ = each.stop.send(true);
            clean &= each.task.await.unwrap_or(false);
        }
        clean
    }
}

async fn keep_running(
    spec: Spec,
    launch: Arc<Launch>,
    first: Child,
    mut stop: watch::Receiver<bool>,
) -> bool {
    let mut backoff = launch.backoff.clone();
    let mut child = Some(first);
    loop {
        let started = Instant::now();
        if let Some(running) = child.as_mut() {
            tokio::select! {
                status = running.wait() => {
                    launch.note(&format!("{} exited unexpectedly ({status:?})", spec.name));
                }
                _ = stop.changed() => return finish(running, &spec, &launch).await,
            }
        }
        let wait = backoff.after(started.elapsed());
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            _ = stop.changed() => return true,
        }
        child = match launch.spawn(&spec).await {
            Ok((started, _)) => Some(started),
            Err(error) => {
                launch.note(&format!("{} did not start: {error}", spec.name));
                None
            }
        };
    }
}

/// Asks the process to stop, and kills it after its grace period.
async fn finish(child: &mut Child, spec: &Spec, launch: &Launch) -> bool {
    stack_os::ask_to_stop(child, spec.stop);
    if tokio::time::timeout(spec.grace, child.wait()).await.is_ok() {
        launch.note(&format!("{} stopped", spec.name));
        return true;
    }
    stack_os::kill(child);
    let _ = child.wait().await;
    launch.note(&format!("{} ignored the stop: killed", spec.name));
    false
}

/// Ends what an earlier start left running: each pid in `run/` whose process still runs a
/// program from `programs` (the installed versions), with its group. A pid now used by anything
/// else is left alone. Returns how many were ended.
pub fn end_leftovers(launch: &Launch, programs: &Path) -> usize {
    let mut ended = 0;
    for entry in fs::read_dir(&launch.run).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "pid") {
            continue;
        }
        let pid = fs::read_to_string(&path)
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok());
        // By text: the folder has a space on macOS ("Application Support"), and there the
        // program is the start of a command line rather than a path of its own.
        let prefix = format!("{}/", programs.display());
        let ours = pid
            .and_then(stack_os::program_of)
            .is_some_and(|program| program.starts_with(&prefix));
        if let (true, Some(pid)) = (ours, pid) {
            let gone = stack_os::end_leftover(pid, Duration::from_secs(10));
            launch.note(&format!(
                "ended a process left from an earlier start ({}, pid {pid}{})",
                path.file_stem().unwrap_or_default().to_string_lossy(),
                if gone { "" } else { ", still running" }
            ));
            ended += 1;
        }
        let _ = fs::remove_file(&path);
    }
    ended
}

/// The logs folder's manager log, for a `Launch`.
pub fn events_log(logs: &Path, max: u64) -> Arc<Mutex<Log>> {
    Log::new(logs.join("manager.log"), max)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::stack_fetch::tests::scratch;

    fn launch(dir: &Path) -> Arc<Launch> {
        let logs = dir.join("logs");
        fs::create_dir_all(&logs).unwrap();
        let run = dir.join("run");
        fs::create_dir_all(&run).unwrap();
        Arc::new(Launch {
            events: events_log(&logs, 1 << 20),
            logs,
            run,
            lock: None,
            backoff: Backoff::new(
                Duration::from_millis(10),
                Duration::from_millis(40),
                Duration::from_secs(60),
            ),
            log_max: 1 << 20,
        })
    }

    /// A stand-in process: a shell script.
    fn fake(name: &'static str, dir: &Path, script: &str) -> Spec {
        Spec {
            name,
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: dir.to_owned(),
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
            stop: Stop::Terminate,
            grace: Duration::from_secs(5),
            on_line: None,
        }
    }

    fn lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn backoff_doubles_up_to_its_cap_and_resets_after_a_stable_run() {
        let mut backoff = Backoff::new(
            Duration::from_secs(1),
            Duration::from_secs(30),
            Duration::from_secs(60),
        );
        let quick = Duration::from_secs(2);
        let waits: Vec<u64> = (0..7).map(|_| backoff.after(quick).as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 30, 30]);
        assert_eq!(backoff.after(Duration::from_secs(61)).as_secs(), 1);
        assert_eq!(backoff.after(quick).as_secs(), 2);
    }

    #[tokio::test]
    async fn stops_the_first_started_last() {
        let dir = scratch("order");
        let launch = launch(&dir);
        let order = dir.join("order");
        let mut supervisor = Supervisor::default();
        for name in ["postgres", "api", "web"] {
            // Each says when it is up and when it is asked to stop.
            let script = format!(
                "trap 'echo stop-{name} >> {o}; exit 0' TERM; echo {name} >> {o}; while :; do sleep 0.05; done",
                o = order.display()
            );
            supervisor
                .keep(fake(name, &dir, &script), launch.clone())
                .await
                .unwrap();
            let line = name.to_owned();
            tokio::time::timeout(Duration::from_secs(5), async {
                while !lines(&order).contains(&line) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
        assert!(supervisor.stop_all().await);
        let said = lines(&order);
        assert_eq!(said[..3], ["postgres", "api", "web"]);
        // The others stop together, Postgres after them.
        let mut others = said[3..5].to_vec();
        others.sort();
        assert_eq!(others, ["stop-api", "stop-web"]);
        assert_eq!(said[5], "stop-postgres");
    }

    #[tokio::test]
    async fn a_process_that_exits_is_started_again() {
        let dir = scratch("restart");
        let launch = launch(&dir);
        let runs = dir.join("runs");
        let mut supervisor = Supervisor::default();
        let script = format!("echo run >> {}; echo out; exit 3", runs.display());
        supervisor
            .keep(fake("api", &dir, &script), launch.clone())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while lines(&runs).len() < 4 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(supervisor.stop_all().await);
        let events = fs::read_to_string(dir.join("logs/manager.log")).unwrap();
        assert!(events.matches("api exited unexpectedly").count() >= 3);
        assert!(
            fs::read_to_string(dir.join("logs/api.log"))
                .unwrap()
                .contains("out\n")
        );
    }

    #[tokio::test]
    async fn one_that_ignores_the_stop_is_killed_with_what_it_started() {
        let dir = scratch("kill");
        let launch = launch(&dir);
        let pids = dir.join("pids");
        let mut spec = fake(
            "worker",
            &dir,
            &format!(
                "trap '' TERM; sleep 300 & echo $$ $! > {}; wait",
                pids.display()
            ),
        );
        spec.grace = Duration::from_millis(200);
        let mut supervisor = Supervisor::default();
        supervisor.keep(spec, launch).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while lines(&pids).is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!supervisor.stop_all().await);
        let child: i32 = lines(&pids)[0].split(' ').nth(1).unwrap().parse().unwrap();
        // The background `sleep` was in the group: gone too (reaped by init, or a zombie).
        tokio::time::sleep(Duration::from_millis(100)).await;
        let state = fs::read_to_string(format!("/proc/{child}/stat")).unwrap_or_default();
        assert!(state.is_empty() || state.contains(") Z "), "{state}");
    }

    #[tokio::test]
    async fn a_step_must_succeed_within_its_limit() {
        let dir = scratch("once");
        let launch = launch(&dir);
        assert!(
            run_once(
                &fake("migrate", &dir, "exit 0"),
                &launch,
                Duration::from_secs(5)
            )
            .await
            .is_ok()
        );
        let failing = fake("migrate", &dir, "exit 1");
        let failed = run_once(&failing, &launch, Duration::from_secs(5)).await;
        assert!(failed.unwrap_err().contains("failed"));
        let sleeping = fake("migrate", &dir, "sleep 30");
        let slow = run_once(&sleeping, &launch, Duration::from_millis(100));
        assert!(slow.await.unwrap_err().contains("longer"));
    }

    #[tokio::test]
    async fn a_step_s_stdout_is_heard_whole_and_line_by_line() {
        let dir = scratch("output");
        let launch = launch(&dir);
        let spec = fake(
            "agent",
            &dir,
            "echo '{\"a\":1}'; echo second; echo oops >&2",
        );
        assert_eq!(
            output(&spec, &launch, Duration::from_secs(5))
                .await
                .unwrap(),
            "{\"a\":1}\nsecond\n"
        );
        let failing = fake("agent", &dir, "echo '{\"event\":\"error\"}'; exit 2");
        let error = output(&failing, &launch, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(error.ends_with(r#"{"event":"error"}"#), "{error}");
    }

    // It reads /proc to see what is still running.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn what_an_earlier_start_left_running_is_ended_and_nothing_else() {
        use std::os::unix::process::CommandExt;
        let dir = scratch("leftovers");
        let launch = launch(&dir);
        // A program "of the server": a copy of sh in the versions folder, started outside any
        // supervisor and with a child of its own, as an orphan from a crashed app would be.
        // Under a folder with a space, as macOS's "Application Support" is.
        let programs = dir.join("Application Support/versions");
        fs::create_dir_all(&programs).unwrap();
        let ours = programs.join("sh");
        fs::copy("/bin/sh", &ours).unwrap();
        let child_pid = dir.join("child");
        let mut orphan = std::process::Command::new(&ours)
            .args([
                "-c",
                &format!("sleep 300 & echo $! > {}; wait", child_pid.display()),
            ])
            .process_group(0)
            .spawn()
            .unwrap();
        let stranger = std::process::Command::new("/bin/sleep")
            .arg("300")
            .spawn()
            .unwrap();
        let orphan_pid = orphan.id();
        // Reaped as init would reap a real orphan, so its end shows at once.
        let reaper = std::thread::spawn(move || orphan.wait());
        fs::write(launch.run.join("api.pid"), orphan_pid.to_string()).unwrap();
        fs::write(launch.run.join("other.pid"), stranger.id().to_string()).unwrap();
        fs::write(launch.run.join("gone.pid"), "999999").unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while lines(&child_pid).is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(end_leftovers(&launch, &programs), 1);
        let alive = |pid: u32| {
            fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| !stat.contains(") Z "))
        };
        let grandchild: u32 = lines(&child_pid)[0].parse().unwrap();
        assert!(!alive(orphan_pid) && !alive(grandchild));
        assert!(
            alive(stranger.id()),
            "a process not of the server is left alone"
        );
        assert_eq!(fs::read_dir(&launch.run).unwrap().count(), 0);
        let mut stranger = stranger;
        let _ = stranger.kill();
        let _ = (stranger.wait(), reaper.join());
        let events = fs::read_to_string(dir.join("logs/manager.log")).unwrap();
        assert!(events.contains("ended a process left from an earlier start (api"));
    }

    #[test]
    fn a_log_is_cut_past_its_size_keeping_one_older_file() {
        let dir = scratch("log");
        let path = dir.join("api.log");
        let log = Log::new(path.clone(), 10);
        for line in ["0123456789\n", "abc\n", "0123456789\n", "def\n"] {
            log.lock().unwrap().write(line.as_bytes());
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), "def\n");
        assert_eq!(
            fs::read_to_string(dir.join("api.log.1")).unwrap(),
            "abc\n0123456789\n"
        );
    }
}
