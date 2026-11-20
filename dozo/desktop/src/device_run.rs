//! Runs what a server's bots ask of this computer, one request at a time per call: the requests a
//! paired computer gets (`provision`, `environment`, `execute`, `cancelRunWork`, `stop`,
//! `destroy`, `prepare`, `isRunning`). The wire format is upstream's host computer protocol
//! (`packages/adapters/src/host-computer-protocol.ts`); its behaviour follows upstream's desktop
//! runner (`host-computer-runner.ts`, `desktop-sandbox.ts`). Screen control is not offered.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, MissedTickBehavior, interval, sleep_until};

/// One frame or request plus its small envelope, in either direction (upstream's limit).
pub const MAX_MESSAGE_BYTES: usize = 12 * 1024 * 1024 + 4096;
const DEFAULT_TIMEOUT_MS: u64 = 5 * 60_000;
const MAX_TIMEOUT_MS: u64 = 60 * 60_000;
const HEARTBEAT: Duration = Duration::from_secs(30);
/// Four slots stay free for cancellation and stop when commands fill the rest.
const MAX_CALLS: usize = 20;
const MAX_WORK: usize = 16;
const BUSY: &str = "Local computer is busy. Try again shortly.";
const INVALID: &str = "Local computer request is invalid";
const FAILED: &str = "Local computer operation failed";
const NO_SCREEN: &str = "Screen control is not available on this computer.";
const NOT_HERE: &str = "Not available on this computer";

/// Variables a shell, tools and app launchers need. Nothing else of the app's own reaches a
/// command (upstream's `HOST_COMMAND_ENV`), compared without case and with every `LC_*`.
const PASSED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TERM",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSH_AUTH_SOCK",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERNAME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "PSMODULEPATH",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
];

/// Where one request's frames go: the socket's outgoing queue, tagged with the request id.
/// Nothing is sent once the call is cancelled, as upstream writes nothing after an abort.
pub struct Reply {
    pub id: String,
    pub out: mpsc::Sender<String>,
    pub cancel: watch::Receiver<bool>,
}

impl Reply {
    /// False when the frame was not sent: cancelled, too large, or the connection is gone.
    pub async fn send(&self, frame: Value) -> bool {
        if *self.cancel.borrow() {
            return false;
        }
        let body = json!({ "type": "frame", "id": self.id, "frame": frame }).to_string();
        if body.len() > MAX_MESSAGE_BYTES {
            let error = json!({ "type": "frame", "id": self.id,
                "frame": { "error": "Local computer response is too large" } });
            let _ = self.out.send(error.to_string()).await;
            return false;
        }
        self.out.send(body).await.is_ok()
    }

    async fn error(&self, message: &str) {
        self.send(json!({ "error": message })).await;
    }
}

/// A command's process group (Unix) or process (Windows), kept to stop it and what it left
/// running in the background.
struct Owned {
    pid: u32,
    bot: String,
    run: Option<String>,
    cancel: watch::Sender<bool>,
}

pub struct Runner {
    root: PathBuf,
    home: PathBuf,
    calls: AtomicUsize,
    owned: Mutex<Vec<Owned>>,
}

/// Released when a call ends, however it ends.
struct Slot<'a>(&'a AtomicUsize);
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Runner {
    /// `root` holds each bot's own folder; `home` is the person's home folder, where commands
    /// may also run.
    pub fn new(root: PathBuf, home: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            root,
            home,
            calls: AtomicUsize::new(0),
            owned: Mutex::new(Vec::new()),
        })
    }

    /// Stops every command and everything they left running.
    pub fn stop_all(&self) {
        for owned in self.owned.lock().unwrap().drain(..) {
            let _ = owned.cancel.send(true);
            kill(owned.pid);
        }
    }

    fn stop_where(&self, matches: impl Fn(&Owned) -> bool) {
        self.owned.lock().unwrap().retain(|owned| {
            if !matches(owned) {
                return true;
            }
            let _ = owned.cancel.send(true);
            kill(owned.pid);
            false
        });
    }

    /// Answers one request. Every outcome is a frame, unless the call was cancelled.
    pub async fn handle(&self, request: &Value, reply: &Reply) {
        if self.calls.fetch_add(1, Ordering::SeqCst) >= MAX_CALLS {
            self.calls.fetch_sub(1, Ordering::SeqCst);
            return reply.error(BUSY).await;
        }
        let _slot = Slot(&self.calls);
        let Some((method, bot, run)) = parse(request) else {
            return reply.error(INVALID).await;
        };
        let lifecycle = matches!(method, "cancelRunWork" | "stop" | "destroy");
        if !lifecycle && self.calls.load(Ordering::SeqCst) > MAX_WORK {
            return reply.error(BUSY).await;
        }
        let home = self.bot_home(bot);
        let key = bot_key(bot);
        let value = match method {
            "environment" => Ok(self.environment()),
            "provision" => provision(&home).map(|fresh| {
                json!({ "id": format!("desktop-{key}"), "botId": bot, "kind": "desktop",
                    "providerRef": format!("host:{key}"), "fresh": fresh })
            }),
            "prepare" => Ok(Value::Null),
            "isRunning" => Ok(Value::Bool(running(&home))),
            "cancelRunWork" => match request.get("targetRunId").and_then(Value::as_str) {
                Some(target) if valid_id(target, 256) => {
                    self.stop_where(|o| o.bot == key && o.run.as_deref() == Some(target));
                    Ok(Value::Null)
                }
                _ => return reply.error(INVALID).await,
            },
            "stop" | "destroy" => {
                self.stop_where(|o| o.bot == key);
                let done = if method == "stop" {
                    stop(&home)
                } else {
                    destroy(&home)
                };
                done.map(|()| Value::Null)
            }
            "execute" => {
                let Some(command) = request.get("command").and_then(parse_command) else {
                    return reply.error(INVALID).await;
                };
                if !running(&home) {
                    return reply.error("Local computer stopped").await;
                }
                return self.execute(&key, run, &home, command, reply).await;
            }
            "screenObserve" | "screenAct" => return reply.error(NO_SCREEN).await,
            "listFiles"
            | "readFile"
            | "writeFile"
            | "workspaceDirectories"
            | "exportWorkspace"
            | "snapshot" => return reply.error(NOT_HERE).await,
            _ => return reply.error(INVALID).await,
        };
        match value {
            Ok(value) => {
                if reply.send(json!({ "value": value })).await {
                    reply.send(json!({ "done": true })).await;
                }
            }
            Err(_) => reply.error(FAILED).await,
        }
    }

    fn environment(&self) -> Value {
        let shell = if cfg!(windows) {
            "powershell.exe".to_owned()
        } else {
            std::env::var("SHELL")
                .ok()
                .filter(|shell| !shell.is_empty())
                .unwrap_or_else(|| "/bin/sh".to_owned())
        };
        json!({ "platform": platform(), "home": self.home.to_string_lossy(), "shell": shell })
    }

    fn bot_home(&self, bot: &str) -> PathBuf {
        self.root.join("desktop-computers").join(bot_key(bot))
    }

    /// Streams the command's output as process events, then `exit` and `done`.
    async fn execute(
        &self,
        key: &str,
        run: Option<&str>,
        home: &Path,
        command: Exec,
        reply: &Reply,
    ) {
        let cwd = match command.cwd.as_deref() {
            None | Some("/home/rakazo" | "/home/user") => home.to_path_buf(),
            Some(cwd) => normalize(&home.join(cwd)),
        };
        if !inside(&cwd, home) && !inside(&cwd, &self.home) {
            return events(reply, "", "path is outside this computer's home", 1).await;
        }
        if std::fs::create_dir_all(&cwd).is_err() {
            return events(reply, "", "could not create the working folder", 1).await;
        }
        let argv = command.argv;
        let program = argv[0].to_ascii_lowercase();
        if argv.iter().any(|arg| arg.contains('\0'))
            || program.ends_with(".bat")
            || program.ends_with(".cmd")
        {
            return events(reply, "", "command rejected", 1).await;
        }
        let mut process = Command::new(&argv[0]);
        process
            .args(&argv[1..])
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear()
            .envs(environment(
                std::env::vars_os(),
                &command.env,
                &command.unset,
            ));
        own_group(&mut process);
        let mut child = match process.spawn() {
            Ok(child) => child,
            // Upstream answers `echo` itself where there is no such program (Windows).
            Err(_) if argv[0] == "echo" => {
                return events(reply, &format!("{}\n", argv[1..].join(" ")), "", 0).await;
            }
            Err(error) => return events(reply, "", &error.to_string(), 1).await,
        };
        let pid = child.id().unwrap_or(0);
        let (stop, mut stopped) = watch::channel(false);
        self.owned.lock().unwrap().push(Owned {
            pid,
            bot: key.to_owned(),
            run: run.map(str::to_owned),
            cancel: stop,
        });
        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let (mut out_text, mut err_text) = (Utf8::default(), Utf8::default());
        let mut cancel = reply.cancel.clone();
        let deadline = Instant::now() + Duration::from_millis(command.timeout_ms);
        let mut heartbeat = interval(HEARTBEAT);
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        heartbeat.tick().await;
        let mut status = None;
        let ended = loop {
            if stdout.is_none()
                && stderr.is_none()
                && let Some(code) = status
            {
                break Ended::Exited(code);
            }
            tokio::select! {
                chunk = read(&mut stdout) => {
                    let text = out_text.push(chunk.as_deref(), &mut stdout);
                    if !text.is_empty() && !reply.send(event("stdout", &text)).await {
                        break Ended::Gone;
                    }
                }
                chunk = read(&mut stderr) => {
                    let text = err_text.push(chunk.as_deref(), &mut stderr);
                    if !text.is_empty() && !reply.send(event("stderr", &text)).await {
                        break Ended::Gone;
                    }
                }
                exit = child.wait(), if status.is_none() => {
                    status = Some(exit.map_or((1, None), exit_code));
                }
                _ = heartbeat.tick() => {
                    if !reply.send(json!({ "heartbeat": true })).await {
                        break Ended::Gone;
                    }
                }
                () = sleep_until(deadline) => {
                    break Ended::Stopped(format!("command timed out after {} ms", command.timeout_ms), 124);
                }
                () = until(&mut cancel) => break Ended::Gone,
                () = until(&mut stopped) => {
                    break Ended::Stopped("command aborted".to_owned(), 130);
                }
            }
        };
        match ended {
            Ended::Exited((code, signal)) => {
                let note = signal.map_or(String::new(), |signal| {
                    format!("command terminated by signal {signal}")
                });
                self.forget_if_gone(pid);
                events(reply, "", &note, code).await;
            }
            Ended::Stopped(note, code) => {
                self.stop_where(|owned| owned.pid == pid);
                kill(pid);
                events(reply, "", &note, code).await;
            }
            Ended::Gone => {
                self.stop_where(|owned| owned.pid == pid);
                kill(pid);
            }
        }
    }

    /// Keeps a finished command's group while something it started still runs, so stopping the
    /// bot or its run still reaches that.
    fn forget_if_gone(&self, pid: u32) {
        self.owned
            .lock()
            .unwrap()
            .retain(|owned| owned.pid != pid || group_alive(pid));
    }
}

enum Ended {
    Exited((i32, Option<i32>)),
    Stopped(String, i32),
    Gone,
}

struct Exec {
    argv: Vec<String>,
    cwd: Option<String>,
    env: Vec<(String, String)>,
    unset: Vec<String>,
    timeout_ms: u64,
}

fn parse(request: &Value) -> Option<(&str, &str, Option<&str>)> {
    let method = request.get("method")?.as_str()?;
    let bot = request
        .get("botId")?
        .as_str()
        .filter(|bot| valid_id(bot, 256))?;
    let run = match request.get("runId") {
        None => None,
        Some(run) => Some(run.as_str().filter(|run| valid_id(run, 256))?),
    };
    Some((method, bot, run))
}

fn valid_id(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max
}

fn parse_command(command: &Value) -> Option<Exec> {
    let argv: Vec<String> = command
        .get("argv")?
        .as_array()?
        .iter()
        .map(|arg| arg.as_str().map(str::to_owned))
        .collect::<Option<_>>()?;
    if argv.is_empty() || argv.len() > 1024 {
        return None;
    }
    let cwd = match command.get("cwd") {
        None => None,
        Some(cwd) => Some(cwd.as_str()?.to_owned()),
    };
    let env = match command.get("env") {
        None => Vec::new(),
        Some(env) => env
            .as_object()?
            .iter()
            .map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned())))
            .collect::<Option<_>>()?,
    };
    let unset = match command.get("unsetEnv") {
        None => Vec::new(),
        Some(unset) => unset
            .as_array()?
            .iter()
            .map(|name| name.as_str().map(str::to_owned))
            .collect::<Option<_>>()?,
    };
    let timeout_ms = command
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .filter(|ms| (1..=MAX_TIMEOUT_MS).contains(ms))
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    Some(Exec {
        argv,
        cwd,
        env,
        unset,
        timeout_ms,
    })
}

/// The command's environment: the allowed part of this app's own, then the request's, minus
/// what the request unsets.
fn environment(
    inherited: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    set: &[(String, String)],
    unset: &[String],
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut env: Vec<_> = inherited
        .filter(|(name, _)| {
            let name = name.to_string_lossy().to_ascii_uppercase();
            name.starts_with("LC_") || PASSED_ENV.contains(&name.as_str())
        })
        .collect();
    for (name, value) in set {
        env.retain(|(existing, _)| !same_name(existing, name));
        env.push((name.into(), value.into()));
    }
    env.retain(|(name, _)| !unset.iter().any(|unset| same_name(name, unset)));
    env
}

/// Windows names are case-insensitive.
fn same_name(name: &std::ffi::OsStr, other: &str) -> bool {
    let name = name.to_string_lossy();
    if cfg!(windows) {
        name.eq_ignore_ascii_case(other)
    } else {
        name == other
    }
}

fn event(kind: &str, data: &str) -> Value {
    json!({ "value": { "type": kind, "data": data } })
}

/// The last events of a command: what it printed, a line on stderr, its exit code, `done`.
async fn events(reply: &Reply, stdout: &str, stderr: &str, code: i32) {
    if !stdout.is_empty() && !reply.send(event("stdout", stdout)).await {
        return;
    }
    if !stderr.is_empty() && !reply.send(event("stderr", &format!("{stderr}\n"))).await {
        return;
    }
    if reply
        .send(json!({ "value": { "type": "exit", "code": code } }))
        .await
    {
        reply.send(json!({ "done": true })).await;
    }
}

/// Resolves once the flag turns true, or its sender is gone.
pub async fn until(flag: &mut watch::Receiver<bool>) {
    let _ = flag.wait_for(|set| *set).await;
}

/// Reads one chunk; `None` at the end, and forever after (the select branch then sleeps).
async fn read<R: AsyncRead + Unpin>(pipe: &mut Option<R>) -> Option<Vec<u8>> {
    let Some(reader) = pipe.as_mut() else {
        return std::future::pending().await;
    };
    let mut buffer = vec![0; 64 * 1024];
    match reader.read(&mut buffer).await {
        Ok(0) | Err(_) => None,
        Ok(read) => {
            buffer.truncate(read);
            Some(buffer)
        }
    }
}

/// Decodes a pipe as UTF-8 without splitting a character across two events.
#[derive(Default)]
struct Utf8(Vec<u8>);

impl Utf8 {
    /// Adds a chunk, or ends the pipe on `None`, and returns the text that is complete.
    fn push<R>(&mut self, chunk: Option<&[u8]>, pipe: &mut Option<R>) -> String {
        let keep = match chunk {
            Some(chunk) => {
                self.0.extend_from_slice(chunk);
                incomplete_tail(&self.0)
            }
            None => {
                *pipe = None;
                0
            }
        };
        let text = String::from_utf8_lossy(&self.0[..self.0.len() - keep]).into_owned();
        self.0.drain(..self.0.len() - keep);
        text
    }
}

/// How many bytes at the end start a character that has not fully arrived yet.
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let width = match byte {
            0xF0.. => 4,
            0xE0.. => 3,
            0xC0.. => 2,
            _ => 1,
        };
        return if width > back { back } else { 0 };
    }
    0
}

fn bot_key(bot: &str) -> String {
    Sha256::digest(bot.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Beside the bot's folder, not in it.
fn stopped_marker(home: &Path) -> PathBuf {
    let mut name = home.as_os_str().to_owned();
    name.push(".stopped");
    PathBuf::from(name)
}

/// Creates the bot's folder; true when it is new.
fn provision(home: &Path) -> std::io::Result<bool> {
    remove_file(&stopped_marker(home))?;
    let fresh = !home.is_dir();
    std::fs::create_dir_all(home)?;
    Ok(fresh)
}

fn running(home: &Path) -> bool {
    home.is_dir() && !stopped_marker(home).exists()
}

fn stop(home: &Path) -> std::io::Result<()> {
    match std::fs::write(stopped_marker(home), "") {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn destroy(home: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(home) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    remove_file(&stopped_marker(home))
}

fn remove_file(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Resolves `.` and `..` without touching the disk, as upstream's `path.resolve` does.
fn normalize(path: &Path) -> PathBuf {
    let mut normal = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normal.pop();
            }
            other => normal.push(other),
        }
    }
    normal
}

fn inside(path: &Path, root: &Path) -> bool {
    normalize(path).starts_with(normalize(root))
}

#[cfg(unix)]
fn exit_code(status: std::process::ExitStatus) -> (i32, Option<i32>) {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(code), _) => (code, None),
        (None, signal) => (1, signal),
    }
}

#[cfg(windows)]
fn exit_code(status: std::process::ExitStatus) -> (i32, Option<i32>) {
    (status.code().unwrap_or(1), None)
}

/// The command leads its own process group, so stopping it stops what it started too.
#[cfg(unix)]
fn own_group(command: &mut Command) {
    command.process_group(0);
}

#[cfg(windows)]
fn own_group(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(unix)]
fn kill(pid: u32) {
    if let Ok(group) = i32::try_from(pid)
        && group > 0
    {
        // SAFETY: a plain signal to the group this app created; no memory is involved.
        unsafe { libc::kill(-group, libc::SIGKILL) };
    }
}

#[cfg(unix)]
fn group_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only asks whether the group still exists.
    i32::try_from(pid).is_ok_and(|group| group > 0 && unsafe { libc::kill(-group, 0) } == 0)
}

/// The process and its children, while the process still runs.
#[cfg(windows)]
fn kill(pid: u32) {
    use std::os::windows::process::CommandExt;
    if pid == 0 {
        return;
    }
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(0x0800_0000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Windows has no group to ask about once the command's own process ended.
#[cfg(windows)]
fn group_alive(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Call {
        frames: mpsc::Receiver<String>,
        // Only the Unix tests cancel a call.
        #[cfg_attr(not(unix), allow(dead_code))]
        cancel: watch::Sender<bool>,
    }

    fn reply(id: &str) -> (Reply, Call) {
        let (out, frames) = mpsc::channel(256);
        let (cancel, cancelled) = watch::channel(false);
        (
            Reply {
                id: id.to_owned(),
                out,
                cancel: cancelled,
            },
            Call { frames, cancel },
        )
    }

    fn runner() -> (Arc<Runner>, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "dozo-device-run-{}-{}",
            std::process::id(),
            bot_key(&format!("{:?}", std::time::Instant::now()))[..12].to_owned()
        ));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        (Runner::new(dir.join("data"), dir.join("home")), dir)
    }

    async fn frames(runner: &Runner, request: Value) -> Vec<Value> {
        let (reply, mut call) = reply("r1");
        runner.handle(&request, &reply).await;
        drop(reply);
        let mut frames = Vec::new();
        while let Some(frame) = call.frames.recv().await {
            let frame: Value = serde_json::from_str(&frame).unwrap();
            assert_eq!(frame["type"], "frame");
            assert_eq!(frame["id"], "r1");
            frames.push(frame["frame"].clone());
        }
        frames
    }

    #[tokio::test]
    async fn the_environment_names_this_platform_and_home() {
        let (runner, dir) = runner();
        let frames = frames(
            &runner,
            json!({ "method": "environment", "botId": "bot-1" }),
        )
        .await;
        assert_eq!(frames[0]["value"]["platform"], platform());
        assert_eq!(
            frames[0]["value"]["home"],
            dir.join("home").to_string_lossy().as_ref()
        );
        assert_eq!(frames[1], json!({ "done": true }));
    }

    #[tokio::test]
    async fn provisioning_is_idempotent_and_execute_needs_it() {
        let (runner, _dir) = runner();
        let execute = json!({ "method": "execute", "botId": "bot-1",
            "command": { "argv": ["echo", "hi"] } });
        assert_eq!(
            frames(&runner, execute.clone()).await,
            vec![json!({ "error": "Local computer stopped" })]
        );
        let first = frames(&runner, json!({ "method": "provision", "botId": "bot-1" })).await;
        assert_eq!(first[0]["value"]["fresh"], true);
        assert_eq!(first[0]["value"]["botId"], "bot-1");
        let again = frames(&runner, json!({ "method": "provision", "botId": "bot-1" })).await;
        assert_eq!(again[0]["value"]["fresh"], false);
        frames(&runner, json!({ "method": "stop", "botId": "bot-1" })).await;
        assert_eq!(
            frames(&runner, execute).await,
            vec![json!({ "error": "Local computer stopped" })]
        );
    }

    #[tokio::test]
    async fn invalid_and_unoffered_requests_are_refused() {
        let (runner, _dir) = runner();
        for (request, error) in [
            (json!({ "method": "environment" }), INVALID),
            (json!({ "method": "environment", "botId": "" }), INVALID),
            (json!({ "method": "nope", "botId": "b" }), INVALID),
            (
                json!({ "method": "execute", "botId": "b", "command": { "argv": [] } }),
                INVALID,
            ),
            (
                json!({ "method": "screenObserve", "botId": "b", "app": "Notes" }),
                NO_SCREEN,
            ),
            (
                json!({ "method": "readFile", "botId": "b", "path": "x" }),
                NOT_HERE,
            ),
        ] {
            assert_eq!(
                frames(&runner, request).await,
                vec![json!({ "error": error })]
            );
        }
    }

    #[cfg(unix)]
    mod unix {
        use super::*;

        fn owned_count(runner: &Runner) -> usize {
            runner.owned.lock().unwrap().len()
        }

        fn stdout_of(frames: &[Value]) -> String {
            frames
                .iter()
                .filter(|frame| frame["value"]["type"] == "stdout")
                .map(|frame| frame["value"]["data"].as_str().unwrap())
                .collect()
        }

        fn exit_of(frames: &[Value]) -> Option<i64> {
            frames
                .iter()
                .find(|frame| frame["value"]["type"] == "exit")
                .and_then(|frame| frame["value"]["code"].as_i64())
        }

        async fn provisioned() -> (Arc<Runner>, PathBuf) {
            let (runner, dir) = runner();
            frames(&runner, json!({ "method": "provision", "botId": "bot-1" })).await;
            (runner, dir)
        }

        fn execute(argv: &[&str], extra: Value) -> Value {
            let mut command = json!({ "argv": argv });
            command
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            json!({ "method": "execute", "botId": "bot-1", "runId": "run-1", "command": command })
        }

        #[tokio::test]
        async fn a_command_runs_with_its_arguments_as_given() {
            let (runner, _dir) = provisioned().await;
            let frames = frames(
                &runner,
                execute(&["printf", "%s|", "merhaba; rm -rf /", "$(id)"], json!({})),
            )
            .await;
            assert_eq!(stdout_of(&frames), "merhaba; rm -rf /|$(id)|");
            assert_eq!(exit_of(&frames), Some(0));
            assert_eq!(frames.last().unwrap(), &json!({ "done": true }));
        }

        #[tokio::test]
        async fn it_runs_in_the_bot_folder_or_the_home_folder_only() {
            let (runner, dir) = provisioned().await;
            let home = frames(
                &runner,
                execute(
                    &["pwd"],
                    json!({ "cwd": dir.join("home/projects").to_string_lossy() }),
                ),
            )
            .await;
            assert_eq!(
                stdout_of(&home).trim(),
                dir.join("home/projects").to_string_lossy()
            );
            for cwd in ["/etc", "../../..", "/tmp"] {
                let refused = frames(&runner, execute(&["pwd"], json!({ "cwd": cwd }))).await;
                assert_eq!(stdout_of(&refused), "");
                assert_eq!(exit_of(&refused), Some(1));
            }
        }

        #[tokio::test]
        async fn only_allowed_variables_reach_a_command() {
            let env = environment(
                [
                    ("PATH".into(), "/bin".into()),
                    ("LC_ALL".into(), "C".into()),
                    ("APP_SECRET".into(), "x".into()),
                    ("HOME".into(), "/h".into()),
                ]
                .into_iter(),
                &[("EXTRA".to_owned(), "1".to_owned())],
                &["HOME".to_owned()],
            );
            let names: Vec<_> = env
                .iter()
                .map(|(name, _)| name.to_string_lossy().into_owned())
                .collect();
            assert_eq!(names, ["PATH", "LC_ALL", "EXTRA"]);
        }

        #[tokio::test]
        async fn a_timeout_stops_the_command_and_says_so() {
            let (runner, _dir) = provisioned().await;
            let frames = frames(
                &runner,
                execute(&["sleep", "30"], json!({ "timeoutMs": 200 })),
            )
            .await;
            assert_eq!(exit_of(&frames), Some(124));
            assert!(
                frames
                    .iter()
                    .any(|f| f["value"]["data"] == "command timed out after 200 ms\n")
            );
        }

        #[tokio::test]
        async fn cancelling_the_run_stops_its_command_and_what_it_left_running() {
            let (runner, dir) = provisioned().await;
            let marker = dir.join("home/left-running");
            let script = format!("(sleep 1; touch {}) & sleep 30", marker.to_string_lossy());
            let (reply, mut call) = reply("long");
            let request = execute(&["/bin/sh", "-c", &script], json!({}));
            let running = {
                let runner = runner.clone();
                tokio::spawn(async move { runner.handle(&request, &reply).await })
            };
            tokio::time::sleep(Duration::from_millis(200)).await;
            frames(
                &runner,
                json!({ "method": "cancelRunWork", "botId": "bot-1", "targetRunId": "run-1" }),
            )
            .await;
            running.await.unwrap();
            let mut sent = Vec::new();
            while let Ok(frame) = call.frames.try_recv() {
                sent.push(serde_json::from_str::<Value>(&frame).unwrap()["frame"].clone());
            }
            assert_eq!(exit_of(&sent), Some(130));
            tokio::time::sleep(Duration::from_millis(1500)).await;
            assert!(!marker.exists());
            drop(call.cancel);
        }

        #[tokio::test]
        async fn a_cancelled_call_sends_nothing_more() {
            let (runner, _dir) = provisioned().await;
            let (reply, mut call) = reply("c");
            let request = execute(&["sleep", "30"], json!({}));
            let running = {
                let runner = runner.clone();
                tokio::spawn(async move { runner.handle(&request, &reply).await })
            };
            tokio::time::sleep(Duration::from_millis(200)).await;
            call.cancel.send(true).unwrap();
            running.await.unwrap();
            assert!(call.frames.try_recv().is_err());
            assert_eq!(owned_count(&runner), 0);
        }

        #[tokio::test]
        async fn output_split_inside_a_character_arrives_whole() {
            let mut text = Utf8::default();
            let mut pipe = Some(());
            let bytes = "ğü".as_bytes();
            assert_eq!(text.push(Some(&bytes[..1]), &mut pipe), "");
            assert_eq!(text.push(Some(&bytes[1..3]), &mut pipe), "ğ");
            assert_eq!(text.push(Some(&bytes[3..]), &mut pipe), "ü");
            assert_eq!(text.push(Some(&[0xE2]), &mut pipe), "");
            assert_eq!(text.push(None, &mut pipe), "\u{FFFD}");
            assert!(pipe.is_none());
        }
    }
}
