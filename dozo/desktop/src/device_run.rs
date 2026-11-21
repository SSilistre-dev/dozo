//! Runs what a server's bots ask of this computer, one request at a time per call: the requests a
//! paired computer gets (`provision`, `environment`, `execute`, `cancelRunWork`, `stop`,
//! `destroy`, `prepare`, `isRunning`). The wire format is upstream's host computer protocol
//! (`packages/adapters/src/host-computer-protocol.ts`); its behaviour follows upstream's desktop
//! runner (`host-computer-runner.ts`, `desktop-sandbox.ts`). Screen control is not offered.
//! `pageBrowser` drives the bot's own browser (`browser.rs`).

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
/// Commands, finished or not, whose leftovers this app still tracks (upstream's limit).
const MAX_OWNED: usize = 256;
/// Carries each command's mark (`Owned::mark`).
const MARK_VAR: &str = "DOZO_COMMAND_MARK";
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

/// Why a call stopped early, as `Reply::cancel` carries it. `CANCELLED`: the server cancelled it,
/// so what the command started outside its group goes too. `LOST`: the connection dropped, so
/// only its group stops.
pub const CANCELLED: u8 = 1;
pub const LOST: u8 = 2;

/// Where one request's frames go: the socket's outgoing queue, tagged with the request id.
/// Nothing is sent once the call is cancelled, as upstream writes nothing after an abort.
pub struct Reply {
    pub id: String,
    pub out: mpsc::Sender<String>,
    /// 0 while it runs, then `CANCELLED` or `LOST`.
    pub cancel: watch::Receiver<u8>,
}

impl Reply {
    /// False when the frame was not sent: cancelled, too large, or the connection is gone.
    pub async fn send(&self, frame: Value) -> bool {
        if *self.cancel.borrow() != 0 {
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
    /// A value only this command's environment carries, inherited by what it starts. Only
    /// Linux can look for it (/proc).
    mark: String,
    bot: String,
    run: Option<String>,
    cancel: watch::Sender<bool>,
}

pub struct Runner {
    root: PathBuf,
    home: PathBuf,
    calls: AtomicUsize,
    owned: Mutex<Vec<Owned>>,
    browsers: crate::browser::Browsers,
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
        let browsers = crate::browser::Browsers::new(root.join("browser-profiles"));
        Self::with_browsers(root, home, browsers)
    }

    pub fn with_browsers(
        root: PathBuf,
        home: PathBuf,
        browsers: crate::browser::Browsers,
    ) -> Arc<Self> {
        let runner = Arc::new(Self {
            root,
            home,
            calls: AtomicUsize::new(0),
            owned: Mutex::new(Vec::new()),
            browsers,
        });
        let held = Arc::downgrade(&runner);
        runner.browsers.set_on_pause(Box::new(move |hold| {
            if let Some(runner) = held.upgrade() {
                runner.hold_commands(hold);
            }
        }));
        runner
    }

    /// While the person signs in with a bot's browser, every command still running here, any
    /// bot's, started before, is held (its process group stopped) and let go after. What left
    /// its group is out of reach, as for a stop.
    fn hold_commands(&self, hold: bool) {
        #[cfg(unix)]
        for owned in self.owned.lock().unwrap().iter() {
            let signal = if hold { libc::SIGSTOP } else { libc::SIGCONT };
            // SAFETY: a plain kill(2) on a group this app started.
            unsafe {
                libc::kill(-(owned.pid as libc::pid_t), signal);
            }
        }
        #[cfg(windows)]
        let _ = hold;
    }

    /// Whether a bot's browser can start here.
    pub fn browser_available(&self) -> bool {
        self.browsers.available()
    }

    /// The prompt a person answers when they sign in in a bot's browser.
    pub fn set_sign_in_prompt(&self, prompt: Arc<dyn crate::browser::SignInPrompt>) {
        self.browsers.set_sign_in_prompt(prompt);
    }

    /// Stops every command and what it left running in its group. `escaped`: also what it
    /// started outside the group (Linux), which only an explicit stop, turning access off or
    /// quitting does, never a dropped connection.
    pub fn stop_all(self: &Arc<Self>, escaped: bool) {
        self.stop_where(|_| true, escaped);
        // A dropped connection keeps the browsers: the person may be using one.
        if escaped {
            self.browsers.close_all();
        }
    }

    /// With `escaped`, the entries go: nothing of them is left. Without, only their groups stop
    /// and the entries stay, so what escaped the group is still found by a later explicit stop
    /// (turning access off, quitting); they are forgotten once nothing of them runs.
    fn stop_where(self: &Arc<Self>, matches: impl Fn(&Owned) -> bool, escaped: bool) {
        let stopped: Vec<(u32, String)> = {
            let mut owned = self.owned.lock().unwrap();
            if escaped {
                let (stop, keep) = owned.drain(..).partition(|owned| matches(owned));
                *owned = keep;
                stop.into_iter()
                    .map(|owned: Owned| {
                        let _ = owned.cancel.send(true);
                        (owned.pid, owned.mark)
                    })
                    .collect()
            } else {
                owned
                    .iter()
                    .filter(|owned| matches(owned))
                    .map(|owned| {
                        let _ = owned.cancel.send(true);
                        (owned.pid, owned.mark.clone())
                    })
                    .collect()
            }
        };
        // Signalled outside the lock: finding marked processes reads /proc.
        for (pid, mark) in stopped {
            kill(pid, &mark, escaped);
            if !escaped {
                self.watch_leftovers(pid, mark);
            }
        }
    }

    /// How many commands' processes are tracked.
    #[cfg(all(test, unix))]
    pub fn tracked(&self) -> usize {
        self.owned.lock().unwrap().len()
    }

    /// Drops the entry of a finished command whose processes are all gone.
    fn forget_if_gone(&self, pid: u32, mark: &str) -> bool {
        let gone = !alive(pid, mark);
        let mut owned = self.owned.lock().unwrap();
        if gone {
            owned.retain(|owned| owned.pid != pid);
        }
        !owned.iter().any(|owned| owned.pid == pid)
    }

    /// Drops a finished command's entry once nothing it started runs any more, checked every
    /// second as upstream does, so a stop never signals a group that is no longer this app's.
    fn watch_leftovers(self: &Arc<Self>, pid: u32, mark: String) {
        let runner = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(runner) = runner.upgrade() else {
                    return;
                };
                let mark = mark.clone();
                let forgotten =
                    tokio::task::spawn_blocking(move || runner.forget_if_gone(pid, &mark)).await;
                if !matches!(forgotten, Ok(false)) {
                    return;
                }
            }
        });
    }

    /// Answers one request. Every outcome is a frame, unless the call was cancelled.
    pub async fn handle(self: &Arc<Self>, request: &Value, reply: &Reply) {
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
                    self.stop_where(|o| o.bot == key && o.run.as_deref() == Some(target), true);
                    Ok(Value::Null)
                }
                _ => return reply.error(INVALID).await,
            },
            "stop" | "destroy" => {
                self.stop_where(|o| o.bot == key, true);
                if crate::browser::DECLARED {
                    self.browsers.close(&key, method == "destroy").await;
                }
                let done = if method == "stop" {
                    stop(&home)
                } else {
                    destroy(&home)
                };
                done.map(|()| Value::Null)
            }
            "execute" => {
                // While the person signs in with any bot's browser, no bot runs anything here: a
                // command could read the screen or reach the browser (`hold_commands`).
                if let Some(site) = self.browsers.anyone_signing() {
                    let refused =
                        format!("The person is signing in to {site}; wait until they are done.");
                    return reply.error(&refused).await;
                }
                let Some(command) = request.get("command").and_then(parse_command) else {
                    return reply.error(INVALID).await;
                };
                if !running(&home) {
                    return reply.error("Local computer stopped").await;
                }
                return self.execute(&key, run, &home, command, reply).await;
            }
            // Not offered until the app declares it (`browser::DECLARED`): a server that asks
            // anyway gets what an unoffered method gets, and no browser starts.
            "pageBrowser" | "pageBrowserSignIn" if !crate::browser::DECLARED => {
                return reply.error(NOT_HERE).await;
            }
            "pageBrowserSignIn" => {
                if !running(&home) {
                    return reply.error("Local computer stopped").await;
                }
                let site = request.get("site").and_then(Value::as_str).unwrap_or("");
                match self.browsers.sign_in(&key, site).await {
                    Ok(signed_in) => Ok(json!({ "signedIn": signed_in })),
                    Err(error) => return reply.error(&error).await,
                }
            }
            "pageBrowser" => {
                if !running(&home) {
                    return reply.error("Local computer stopped").await;
                }
                let command = request.get("command").unwrap_or(&Value::Null);
                match self.browsers.handle(&key, command).await {
                    Ok(value) => Ok(value),
                    Err(error) => return reply.error(&error).await,
                }
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
        self: &Arc<Self>,
        key: &str,
        run: Option<&str>,
        home: &Path,
        command: Exec,
        reply: &Reply,
    ) {
        let cwd = match command.cwd.as_deref() {
            // The server's own name for a computer's home (upstream's resolveExecuteCwd, as the
            // staged build renames it): it means this bot's folder.
            None | Some("/home/dozo" | "/home/user") => home.to_path_buf(),
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
        if self.owned.lock().unwrap().len() >= MAX_OWNED {
            return reply.error("Too many local background commands").await;
        }
        let mark = new_mark();
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
            ))
            .env(MARK_VAR, &mark);
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
            mark: mark.clone(),
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
                        break Ended::Gone(why(&cancel));
                    }
                }
                chunk = read(&mut stderr) => {
                    let text = err_text.push(chunk.as_deref(), &mut stderr);
                    if !text.is_empty() && !reply.send(event("stderr", &text)).await {
                        break Ended::Gone(why(&cancel));
                    }
                }
                exit = child.wait(), if status.is_none() => {
                    status = Some(exit.map_or((1, None), exit_code));
                }
                _ = heartbeat.tick() => {
                    if !reply.send(json!({ "heartbeat": true })).await {
                        break Ended::Gone(why(&cancel));
                    }
                }
                () = sleep_until(deadline) => {
                    break Ended::Stopped(format!("command timed out after {} ms", command.timeout_ms), 124);
                }
                kind = cancelled(&mut cancel) => break Ended::Gone(kind),
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
                let runner = self.clone();
                let checked = mark.clone();
                let forgotten =
                    tokio::task::spawn_blocking(move || runner.forget_if_gone(pid, &checked)).await;
                if !matches!(forgotten, Ok(true)) {
                    self.watch_leftovers(pid, mark);
                }
                events(reply, "", &note, code).await;
            }
            // A timeout stops the group; a stop from the runner has already done its part.
            Ended::Stopped(note, code) => {
                self.stop_where(|owned| owned.pid == pid, false);
                events(reply, "", &note, code).await;
            }
            Ended::Gone(kind) => self.stop_where(|owned| owned.pid == pid, kind == CANCELLED),
        }
    }
}

enum Ended {
    Exited((i32, Option<i32>)),
    Stopped(String, i32),
    /// Cancelled or the connection dropped (`CANCELLED`, `LOST`).
    Gone(u8),
}

/// Why sending failed: the call's cancel reason, or a dropped connection.
fn why(cancel: &watch::Receiver<u8>) -> u8 {
    match *cancel.borrow() {
        0 => LOST,
        kind => kind,
    }
}

/// Resolves with the cancel reason once the call is cancelled; `LOST` when its sender is gone.
async fn cancelled(cancel: &mut watch::Receiver<u8>) -> u8 {
    match cancel.wait_for(|kind| *kind != 0).await {
        Ok(kind) => *kind,
        Err(_) => LOST,
    }
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

fn new_mark() -> String {
    use std::hash::{BuildHasher, RandomState};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let next = NEXT.fetch_add(1, Ordering::SeqCst);
    format!("{:016x}{next:x}", RandomState::new().hash_one(next))
}

/// Every live process carrying the mark, with its process group: the command, and on Linux
/// also what it started in a new session or group (`setsid`, a double fork), which keeps the
/// environment it inherited. Read from /proc; this user's processes only.
#[cfg(target_os = "linux")]
fn marked(mark: &str) -> Vec<(i32, i32)> {
    let needle = format!("{MARK_VAR}={mark}");
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let pid: i32 = entry.ok()?.file_name().to_str()?.parse().ok()?;
            let environ = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
            if !environ
                .split(|byte| *byte == 0)
                .any(|var| var == needle.as_bytes())
            {
                return None;
            }
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let group = stat
                .rsplit_once(')')?
                .1
                .split_whitespace()
                .nth(2)?
                .parse()
                .ok()?;
            Some((pid, group))
        })
        .collect()
}

/// Stops a command's group and, with `escaped`, every process carrying its mark (what it started
/// in a new session or group). The group is signalled only while a marked process still belongs
/// to it, so a group id the system has since given to someone else is never hit.
#[cfg(target_os = "linux")]
fn kill(pid: u32, mark: &str, escaped: bool) {
    let marked = marked(mark);
    let group = i32::try_from(pid).unwrap_or(0);
    // SAFETY: plain signals to processes found above; no memory is involved.
    unsafe {
        if group > 0 && marked.iter().any(|(_, pgrp)| *pgrp == group) {
            libc::kill(-group, libc::SIGKILL);
        }
        if escaped {
            for (pid, _) in marked {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn alive(_pid: u32, mark: &str) -> bool {
    !marked(mark).is_empty()
}

/// macOS has no /proc to find marked processes: the group alone, which the entry is dropped
/// for within a second of emptying (`watch_leftovers`).
#[cfg(target_os = "macos")]
fn kill(pid: u32, mark: &str, _escaped: bool) {
    if alive(pid, mark) {
        // SAFETY: a plain signal to the group this app created; no memory is involved.
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    }
}

#[cfg(target_os = "macos")]
fn alive(pid: u32, _mark: &str) -> bool {
    // SAFETY: signal 0 only asks whether the group still exists.
    i32::try_from(pid).is_ok_and(|group| group > 0 && unsafe { libc::kill(-group, 0) } == 0)
}

/// The process and its children, while the process still runs.
#[cfg(windows)]
fn kill(pid: u32, _mark: &str, _escaped: bool) {
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
fn alive(_pid: u32, _mark: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Call {
        frames: mpsc::Receiver<String>,
        // Only the Unix tests cancel a call.
        #[cfg_attr(not(unix), allow(dead_code))]
        cancel: watch::Sender<u8>,
    }

    fn reply(id: &str) -> (Reply, Call) {
        let (out, frames) = mpsc::channel(256);
        let (cancel, cancelled) = watch::channel(0);
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

    async fn frames(runner: &Arc<Runner>, request: Value) -> Vec<Value> {
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

    /// Until the app declares its browser, a server's `pageBrowser` is refused before any browser
    /// is looked for or started, even for a provisioned, running bot.
    #[tokio::test]
    async fn the_bot_s_browser_is_refused_while_it_is_not_declared() {
        let (runner, dir) = runner();
        let provision = json!({ "method": "provision", "botId": "b" });
        assert!(frames(&runner, provision).await[0].get("value").is_some());
        let page = json!({ "method": "pageBrowser", "botId": "b",
            "command": { "method": "Page.navigate", "params": { "url": "https://example.com/" } } });
        assert_eq!(
            frames(&runner, page).await,
            vec![json!({ "error": NOT_HERE })]
        );
        let sign_in = json!({ "method": "pageBrowserSignIn", "botId": "b", "site": "example.com" });
        assert_eq!(
            frames(&runner, sign_in).await,
            vec![json!({ "error": NOT_HERE })]
        );
        assert!(
            !dir.join("data").join("browser-profiles").exists(),
            "no profile was made"
        );
    }

    /// While the person signs in with a bot's browser, that bot runs no command here, and
    /// stopping it leaves the browser alone. Unix only: Windows has no bot's browser, and the
    /// command left running is a shell one.
    #[cfg(unix)]
    #[tokio::test]
    async fn nothing_runs_while_the_person_signs_in_with_a_bot_s_browser() {
        let dir =
            std::env::temp_dir().join(format!("dozo-device-run-signing-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        let browsers =
            crate::browser::Browsers::with(dir.join("data/browser-profiles"), None, true);
        let runner = Runner::with_browsers(dir.join("data"), dir.join("home"), browsers);
        for bot in ["b", "c"] {
            let provision = json!({ "method": "provision", "botId": bot });
            assert!(frames(&runner, provision).await[0].get("value").is_some());
        }
        // Another bot's command left running from before.
        let pid_file = dir.join("home/sleeper.pid");
        let leave = format!(
            "sleep 30 >/dev/null 2>&1 & echo $! > {}",
            pid_file.display()
        );
        let started = json!({ "method": "execute", "botId": "c",
            "command": { "argv": ["sh", "-c", leave], "cwd": dir.join("home").to_string_lossy() } });
        frames(&runner, started).await;
        let sleeper: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        runner
            .browsers
            .mark_signing(&bot_key("b"), Some("example.com"));
        let refusal = "The person is signing in to example.com; wait until they are done.";
        for bot in ["b", "c"] {
            let execute =
                json!({ "method": "execute", "botId": bot, "command": { "argv": ["true"] } });
            assert_eq!(
                frames(&runner, execute).await,
                vec![json!({ "error": refusal })],
                "{bot}"
            );
        }
        #[cfg(target_os = "linux")]
        {
            let state = |pid: u32| {
                let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
                stat.rsplit_once(')')
                    .unwrap()
                    .1
                    .split_whitespace()
                    .next()
                    .unwrap()
                    .to_owned()
            };
            assert_eq!(state(sleeper), "T", "held while the person signs in");
            runner.browsers.mark_signing(&bot_key("b"), None);
            assert_ne!(state(sleeper), "T", "let go after");
        }
        #[cfg(not(target_os = "linux"))]
        runner.browsers.mark_signing(&bot_key("b"), None);
        let after = json!({ "method": "execute", "botId": "c", "command": { "argv": ["true"] } });
        assert_ne!(
            frames(&runner, after).await[0].get("error"),
            Some(&json!(refusal))
        );
        runner.stop_all(true);
        let _ = sleeper;
        let _ = std::fs::remove_dir_all(&dir);
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
        async fn the_servers_home_folder_is_the_bot_folder() {
            let (runner, _dir) = provisioned().await;
            let bot = frames(&runner, execute(&["pwd"], json!({}))).await;
            for cwd in ["/home/dozo", "/home/user"] {
                let named = frames(&runner, execute(&["pwd"], json!({ "cwd": cwd }))).await;
                assert_eq!(exit_of(&named), Some(0), "{cwd}");
                assert_eq!(stdout_of(&named), stdout_of(&bot), "{cwd}");
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

        /// `setsid` and a double fork leave the command's group; on Linux the mark still finds
        /// them. (macOS: they escape; see README, "Bots on this computer".)
        #[cfg(target_os = "linux")]
        #[tokio::test]
        async fn what_a_command_starts_in_a_new_session_stops_with_its_run() {
            let (runner, dir) = provisioned().await;
            let marker = dir.join("home/escaped");
            let script = format!(
                "setsid sh -c 'sleep 1; touch {}' & sleep 30",
                marker.to_string_lossy()
            );
            let (reply, _call) = reply("long");
            let request = execute(&["/bin/sh", "-c", &script], json!({}));
            let running = {
                let runner = runner.clone();
                tokio::spawn(async move { runner.handle(&request, &reply).await })
            };
            tokio::time::sleep(Duration::from_millis(300)).await;
            frames(
                &runner,
                json!({ "method": "cancelRunWork", "botId": "bot-1", "targetRunId": "run-1" }),
            )
            .await;
            running.await.unwrap();
            tokio::time::sleep(Duration::from_millis(1500)).await;
            assert!(!marker.exists());
        }

        #[cfg(target_os = "linux")]
        #[tokio::test]
        async fn leftovers_are_forgotten_once_they_end() {
            let (runner, _dir) = provisioned().await;
            let frames = frames(
                &runner,
                execute(
                    &["/bin/sh", "-c", "sleep 2 >/dev/null 2>&1 & exit 0"],
                    json!({}),
                ),
            )
            .await;
            assert_eq!(exit_of(&frames), Some(0));
            assert_eq!(owned_count(&runner), 1);
            tokio::time::sleep(Duration::from_millis(3500)).await;
            assert_eq!(owned_count(&runner), 0);
        }

        /// A dropped connection stops the command's group only: what left the group (here a
        /// new session, as an app a command opened could be) is spared.
        #[cfg(target_os = "linux")]
        #[tokio::test]
        async fn a_dropped_connection_spares_what_left_the_group() {
            let (runner, dir) = provisioned().await;
            let marker = dir.join("home/spared");
            let script = format!(
                "setsid sh -c 'sleep 1; touch {}' & sleep 30",
                marker.to_string_lossy()
            );
            let (reply, call) = reply("long");
            let request = execute(&["/bin/sh", "-c", &script], json!({}));
            let running = {
                let runner = runner.clone();
                tokio::spawn(async move { runner.handle(&request, &reply).await })
            };
            tokio::time::sleep(Duration::from_millis(300)).await;
            call.cancel.send(LOST).unwrap();
            running.await.unwrap();
            tokio::time::sleep(Duration::from_millis(1500)).await;
            assert!(marker.exists());
            runner.stop_all(true);
        }

        /// What escaped the group outlives a dropped connection only until access ends: turning
        /// it off (an explicit stop of everything) still finds it.
        #[cfg(target_os = "linux")]
        #[tokio::test]
        async fn what_escaped_is_still_stopped_when_access_ends_after_a_drop() {
            let (runner, dir) = provisioned().await;
            let marker = dir.join("home/late");
            let script = format!(
                "setsid sh -c 'sleep 2; touch {}' & sleep 30",
                marker.to_string_lossy()
            );
            let (reply, call) = reply("long");
            let request = execute(&["/bin/sh", "-c", &script], json!({}));
            let running = {
                let runner = runner.clone();
                tokio::spawn(async move { runner.handle(&request, &reply).await })
            };
            tokio::time::sleep(Duration::from_millis(300)).await;
            call.cancel.send(LOST).unwrap();
            running.await.unwrap();
            // The grace passed without the connection: groups only.
            runner.stop_all(false);
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert_eq!(
                owned_count(&runner),
                1,
                "the escaped process keeps its entry"
            );
            // Turning access off.
            runner.stop_all(true);
            tokio::time::sleep(Duration::from_millis(2500)).await;
            assert!(!marker.exists());
            assert_eq!(owned_count(&runner), 0);
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
            call.cancel.send(CANCELLED).unwrap();
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
