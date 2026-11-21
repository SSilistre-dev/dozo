//! The bot's own browser on this computer: a Chromium-family browser already installed here
//! (Chrome, Edge, Brave or Chromium), started with a profile folder of the bot's own, never the
//! person's, in a normal window with its address bar. The server drives the page through the
//! DevTools protocol (`pageBrowser` requests), and only over a pipe: no TCP port is opened, so no
//! other program on this computer can connect to it. This side passes on only the commands in
//! `ALLOWED`, with only the parameters listed there, to the bot's one page; it never passes on
//! what reads cookies or site storage, or runs script (`Runtime.evaluate`), so neither reaches
//! the server. Downloads are refused.
//!
//! The browser ends with the app: on Linux the kernel ends it when the app ends however it ends
//! (`stack_os::prepare`); everywhere the closed pipe ends it, and a profile's last browser is
//! ended before the next one starts (`end_leftover`). Windows: not yet (`find` finds none).
//!
//! The honest limit: a bot that may run commands runs them as this user, so it can read the
//! profile folder with a command. Keeping commands off keeps the profile to the browser.

// Windows starts no browser yet, so the pipe and the launch are not used there.
#![cfg_attr(windows, allow(dead_code))]

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

/// The commands the server may send, each with the parameters passed on. Anything else is
/// refused, and so is any other parameter.
const ALLOWED: &[(&str, &[&str])] = &[
    ("Accessibility.enable", &[]),
    ("Accessibility.getFullAXTree", &["depth"]),
    (
        "Accessibility.getPartialAXTree",
        &["backendNodeId", "fetchRelatives"],
    ),
    (
        "Accessibility.queryAXTree",
        &["backendNodeId", "accessibleName", "role"],
    ),
    ("DOM.enable", &[]),
    ("DOM.getDocument", &["depth"]),
    ("DOM.describeNode", &["backendNodeId"]),
    ("DOM.getBoxModel", &["backendNodeId"]),
    ("DOM.getContentQuads", &["backendNodeId"]),
    ("DOM.scrollIntoViewIfNeeded", &["backendNodeId", "rect"]),
    ("DOM.focus", &["backendNodeId"]),
    (
        "Input.dispatchMouseEvent",
        &[
            "type",
            "x",
            "y",
            "button",
            "buttons",
            "clickCount",
            "deltaX",
            "deltaY",
            "modifiers",
            "pointerType",
        ],
    ),
    (
        "Input.dispatchKeyEvent",
        &[
            "type",
            "key",
            "code",
            "text",
            "unmodifiedText",
            "windowsVirtualKeyCode",
            "nativeVirtualKeyCode",
            "modifiers",
            "autoRepeat",
            "isKeypad",
            "location",
        ],
    ),
    ("Input.insertText", &["text"]),
    ("Page.enable", &[]),
    ("Page.navigate", &["url"]),
    ("Page.reload", &["ignoreCache"]),
    ("Page.stopLoading", &[]),
    ("Page.getNavigationHistory", &[]),
    ("Page.navigateToHistoryEntry", &["entryId"]),
    (
        "Page.captureScreenshot",
        &["format", "quality", "clip", "captureBeyondViewport"],
    ),
    ("Page.getLayoutMetrics", &[]),
    ("Page.getFrameTree", &[]),
    ("Page.bringToFront", &[]),
    ("Page.handleJavaScriptDialog", &["accept", "promptText"]),
];

/// Page events the server gets back with its next answer, so it can tell a load finished or a
/// dialog opened without asking the page to run anything.
const EVENTS: &[&str] = &[
    "Page.loadEventFired",
    "Page.domContentEventFired",
    "Page.frameNavigated",
    "Page.javascriptDialogOpening",
    "Page.javascriptDialogClosed",
    "Inspector.targetCrashed",
];
const MAX_EVENTS: usize = 64;
const ANSWER: Duration = Duration::from_secs(30);

pub const NO_BROWSER: &str = "No Chrome, Edge, Brave or Chromium is installed on this computer.";
const CLOSED: &str = "The bot's browser closed.";

/// The browser this computer would start, if any: the first of Chrome, Edge, Brave and Chromium.
/// A Snap package is passed over: it cannot use a profile folder inside the app's data.
#[cfg(target_os = "macos")]
pub fn find() -> Option<PathBuf> {
    let apps = [
        "Google Chrome.app/Contents/MacOS/Google Chrome",
        "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "Brave Browser.app/Contents/MacOS/Brave Browser",
        "Chromium.app/Contents/MacOS/Chromium",
    ];
    let home = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Applications"));
    let folders = [Some(PathBuf::from("/Applications")), home];
    apps.iter().find_map(|app| {
        folders
            .iter()
            .flatten()
            .map(|folder| folder.join(app))
            .find(|path| path.is_file())
    })
}

#[cfg(target_os = "linux")]
pub fn find() -> Option<PathBuf> {
    let names = [
        "google-chrome",
        "google-chrome-stable",
        "microsoft-edge",
        "microsoft-edge-stable",
        "brave-browser",
        "brave",
        "chromium",
        "chromium-browser",
    ];
    let path = std::env::var_os("PATH")?;
    names.iter().find_map(|name| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .filter(|candidate| is_executable(candidate))
            .find(|candidate| {
                let real = std::fs::canonicalize(candidate).unwrap_or_default();
                !candidate.starts_with("/snap/") && !real.starts_with("/snap/")
            })
    })
}

#[cfg(target_os = "linux")]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
pub fn find() -> Option<PathBuf> {
    None
}

/// The arguments the browser starts with. Never Playwright's defaults that mark it as automated
/// or keep its passwords unencrypted (`--enable-automation`, `--use-mock-keychain`,
/// `--password-store=basic`), never `--app` or kiosk (the address bar stays), and never a
/// debugging port.
fn arguments(profile: &Path, headless: bool) -> Vec<String> {
    let mut args = vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-pipe".to_owned(),
        "--no-first-run".to_owned(),
        "--no-default-browser-check".to_owned(),
    ];
    if headless {
        args.push("--headless=new".to_owned());
    }
    args.push("about:blank".to_owned());
    args
}

/// Checks one command from the server and keeps only the parameters it may carry.
pub fn allowed(command: &Value) -> Result<(String, Value), String> {
    let method = command
        .get("method")
        .and_then(Value::as_str)
        .ok_or("pageBrowser needs a method")?;
    let Some((_, keys)) = ALLOWED.iter().find(|(name, _)| *name == method) else {
        return Err(format!("Not allowed in the bot's browser: {method}"));
    };
    let given = match command.get("params") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(params)) => params.clone(),
        Some(_) => return Err("pageBrowser params must be an object".to_owned()),
    };
    if let Some(extra) = given.keys().find(|key| !keys.contains(&key.as_str())) {
        return Err(format!(
            "Not allowed in the bot's browser: {method} {extra}"
        ));
    }
    if method == "Page.navigate" {
        let url = given.get("url").and_then(Value::as_str).unwrap_or_default();
        if !web_address(url) {
            return Err("The bot's browser opens only http and https addresses".to_owned());
        }
    }
    if method == "Input.dispatchKeyEvent" && pastes(&given) {
        return Err("Not allowed in the bot's browser: paste".to_owned());
    }
    Ok((method.to_owned(), Value::Object(given)))
}

/// An address a page may be sent to: http, https or a blank page. Never `javascript:`, `file:`,
/// `data:` or the browser's own pages.
fn web_address(url: &str) -> bool {
    if url == "about:blank" {
        return true;
    }
    tauri::Url::parse(url)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}

/// A key press that would paste the person's clipboard into the bot's page: Ctrl or Cmd with V,
/// or Shift with Insert.
fn pastes(params: &Map<String, Value>) -> bool {
    let modifiers = params.get("modifiers").and_then(Value::as_u64).unwrap_or(0);
    let named = |value: &str| {
        ["key", "code"]
            .iter()
            .filter_map(|field| params.get(*field).and_then(Value::as_str))
            .any(|given| given.eq_ignore_ascii_case(value))
    };
    let code = params
        .get("windowsVirtualKeyCode")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let control_or_command = modifiers & (2 | 4) != 0;
    let shift = modifiers & 8 != 0;
    (control_or_command && (named("v") || named("KeyV") || code == 86))
        || (shift && (named("Insert") || code == 45))
}

/// One browser's end of the pipe: commands out, answers and events back.
struct Pipe {
    to_browser: tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next: AtomicU64,
    open: AtomicBool,
    /// The bot's page, once attached; cleared when the page goes.
    session: Mutex<Option<String>>,
    events: Mutex<VecDeque<Value>>,
}

impl Pipe {
    fn start(
        to_browser: Box<dyn tokio::io::AsyncWrite + Send + Unpin>,
        from_browser: impl tokio::io::AsyncRead + Send + Unpin + 'static,
    ) -> Arc<Self> {
        let pipe = Arc::new(Self {
            to_browser: tokio::sync::Mutex::new(to_browser),
            pending: Mutex::default(),
            next: AtomicU64::new(1),
            open: AtomicBool::new(true),
            session: Mutex::default(),
            events: Mutex::default(),
        });
        tokio::spawn(read(Arc::downgrade(&pipe), from_browser));
        pipe
    }

    /// Sends one command, to the bot's page when `session` is given, and waits for its answer.
    async fn call(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, String> {
        use tokio::io::AsyncWriteExt;
        if !self.open.load(Ordering::SeqCst) {
            return Err(CLOSED.to_owned());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        let mut bytes = message.to_string().into_bytes();
        bytes.push(0);
        let (answer, answered) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, answer);
        let written = {
            let mut out = self.to_browser.lock().await;
            out.write_all(&bytes).await.and(out.flush().await)
        };
        if written.is_err() {
            self.pending.lock().unwrap().remove(&id);
            self.close();
            return Err(CLOSED.to_owned());
        }
        let reply = match tokio::time::timeout(ANSWER, answered).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => return Err(CLOSED.to_owned()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                return Err(format!("The bot's browser did not answer {method} in time"));
            }
        };
        match reply.get("error") {
            Some(error) => Err(format!(
                "The bot's browser refused {method}: {}",
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("error")
            )),
            None => Ok(reply.get("result").cloned().unwrap_or(Value::Null)),
        }
    }

    fn close(&self) {
        self.open.store(false, Ordering::SeqCst);
        // Dropping the senders answers every waiting call with "closed".
        self.pending.lock().unwrap().clear();
    }

    fn take_events(&self) -> Vec<Value> {
        self.events.lock().unwrap().drain(..).collect()
    }

    /// Keeps an answer for its call, and the bot's page's events for the next answer.
    fn receive(&self, message: Value) {
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if let Some(answer) = self.pending.lock().unwrap().remove(&id) {
                let _ = answer.send(message);
            }
            return;
        }
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let session = message.get("sessionId").and_then(Value::as_str);
        let mut ours = self.session.lock().unwrap();
        if method == "Target.detachedFromTarget" {
            let gone = message["params"]["sessionId"].as_str();
            if gone.is_some() && gone == ours.as_deref() {
                *ours = None;
            }
            return;
        }
        if session.is_none() || session != ours.as_deref() || !EVENTS.contains(&method) {
            return;
        }
        // Only the page's own navigations: a frame inside it is the page's business.
        if method == "Page.frameNavigated" && message["params"]["frame"].get("parentId").is_some() {
            return;
        }
        drop(ours);
        let mut events = self.events.lock().unwrap();
        if events.len() == MAX_EVENTS {
            events.pop_front();
        }
        events.push_back(json!({ "method": method, "params": message["params"] }));
    }
}

/// Reads NUL-terminated messages from the browser until the pipe closes.
async fn read(pipe: std::sync::Weak<Pipe>, mut from: impl tokio::io::AsyncRead + Unpin) {
    use tokio::io::AsyncReadExt;
    let mut buffer = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = from.read(&mut chunk).await.unwrap_or(0);
        let Some(pipe) = pipe.upgrade() else { return };
        if read == 0 {
            pipe.close();
            return;
        }
        buffer.extend_from_slice(&chunk[..read]);
        while let Some(end) = buffer.iter().position(|byte| *byte == 0) {
            let message: Vec<u8> = buffer.drain(..=end).collect();
            if let Ok(message) = serde_json::from_slice::<Value>(&message[..end]) {
                pipe.receive(message);
            }
        }
        // A message larger than any answer the server could take is not a browser's.
        if buffer.len() > crate::device_run::MAX_MESSAGE_BYTES * 2 {
            pipe.close();
            return;
        }
    }
}

/// One running browser for one bot.
struct Running {
    pipe: Arc<Pipe>,
    /// One attach at a time, so two calls never open two pages.
    attach: tokio::sync::Mutex<()>,
    #[cfg(unix)]
    child: Mutex<Option<tokio::process::Child>>,
}

impl Running {
    /// The bot's page, attached once: its first tab, or a new one if the person closed them all.
    async fn page(&self) -> Result<String, String> {
        let _attaching = self.attach.lock().await;
        if let Some(session) = self.pipe.session.lock().unwrap().clone() {
            return Ok(session);
        }
        let mut target = None;
        for _ in 0..50 {
            let targets = self.pipe.call("Target.getTargets", json!({}), None).await?;
            target = targets["targetInfos"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|info| info["type"] == "page")
                .and_then(|info| info["targetId"].as_str().map(str::to_owned));
            if target.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let target = match target {
            Some(target) => target,
            None => self
                .pipe
                .call("Target.createTarget", json!({ "url": "about:blank" }), None)
                .await?["targetId"]
                .as_str()
                .ok_or(CLOSED)?
                .to_owned(),
        };
        let attached = self
            .pipe
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target, "flatten": true }),
                None,
            )
            .await?;
        let session = attached["sessionId"].as_str().ok_or(CLOSED)?.to_owned();
        *self.pipe.session.lock().unwrap() = Some(session.clone());
        self.pipe
            .call("Page.enable", json!({}), Some(&session))
            .await?;
        Ok(session)
    }

    fn end(&self) {
        self.pipe.close();
        #[cfg(unix)]
        if let Some(mut child) = self.child.lock().unwrap().take() {
            crate::stack_os::kill(&mut child);
        }
    }
}

/// Every bot's browser on this computer, each with its own profile under `root`.
pub struct Browsers {
    root: PathBuf,
    program: Option<PathBuf>,
    headless: bool,
    open: Mutex<HashMap<String, Arc<Running>>>,
    /// One start at a time.
    starting: tokio::sync::Mutex<()>,
    /// Moves on with every `close_all`, so a browser that was starting meanwhile is ended.
    generation: AtomicU64,
}

impl Browsers {
    pub fn new(root: PathBuf) -> Self {
        Self::with(root, find(), false)
    }

    /// A given browser program, or none; tests run it without a window.
    pub fn with(root: PathBuf, program: Option<PathBuf>, headless: bool) -> Self {
        Self {
            root,
            program,
            headless,
            open: Mutex::default(),
            starting: tokio::sync::Mutex::default(),
            generation: AtomicU64::new(0),
        }
    }

    pub fn available(&self) -> bool {
        self.program.is_some()
    }

    /// Runs one allowed command on the bot's page, starting its browser when none runs, and
    /// answers with the result and the page events since the last answer.
    pub async fn handle(&self, key: &str, command: &Value) -> Result<Value, String> {
        let (method, params) = allowed(command)?;
        let running = self.running(key).await?;
        let session = match running.page().await {
            Ok(session) => session,
            Err(error) => {
                self.forget(key, &running);
                return Err(error);
            }
        };
        let result = running.pipe.call(&method, params, Some(&session)).await;
        if !running.pipe.open.load(Ordering::SeqCst) {
            self.forget(key, &running);
        }
        Ok(json!({ "result": result?, "events": running.pipe.take_events() }))
    }

    fn current(&self, key: &str) -> Option<Arc<Running>> {
        let open = self.open.lock().unwrap();
        open.get(key)
            .filter(|running| running.pipe.open.load(Ordering::SeqCst))
            .cloned()
    }

    async fn running(&self, key: &str) -> Result<Arc<Running>, String> {
        if let Some(running) = self.current(key) {
            return Ok(running);
        }
        let _starting = self.starting.lock().await;
        if let Some(running) = self.current(key) {
            return Ok(running);
        }
        let program = self.program.as_deref().ok_or(NO_BROWSER)?;
        let generation = self.generation.load(Ordering::SeqCst);
        let running = Arc::new(self.start(program, key).await?);
        let mut open = self.open.lock().unwrap();
        if self.generation.load(Ordering::SeqCst) != generation {
            running.end();
            return Err(CLOSED.to_owned());
        }
        open.insert(key.to_owned(), running.clone());
        Ok(running)
    }

    fn forget(&self, key: &str, running: &Arc<Running>) {
        let mut open = self.open.lock().unwrap();
        if open
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, running))
        {
            open.remove(key);
        }
        running.end();
    }

    /// Ends the bot's browser. `forget_profile` also removes its profile (the bot is gone).
    pub fn close(&self, key: &str, forget_profile: bool) {
        let running = self.open.lock().unwrap().remove(key);
        if let Some(running) = running {
            running.end();
        }
        if forget_profile {
            let _ = std::fs::remove_dir_all(self.root.join(key));
            let _ = std::fs::remove_file(self.root.join(format!("{key}.pid")));
        }
    }

    /// Ends every bot's browser (access turned off, or the app quits).
    pub fn close_all(&self) {
        let open = {
            let mut open = self.open.lock().unwrap();
            self.generation.fetch_add(1, Ordering::SeqCst);
            std::mem::take(&mut *open)
        };
        for running in open.values() {
            running.end();
        }
    }

    #[cfg(unix)]
    async fn start(&self, program: &Path, key: &str) -> Result<Running, String> {
        let profile = self.root.join(key);
        private_folder(&self.root).map_err(|_| "The bot's browser profile could not be made")?;
        private_folder(&profile).map_err(|_| "The bot's browser profile could not be made")?;
        let pid_file = self.root.join(format!("{key}.pid"));
        end_leftover(&pid_file, &profile);
        let (child, pipe) = launch(program, &arguments(&profile, self.headless))
            .await
            .map_err(|_| "The bot's browser could not start".to_owned())?;
        if let Some(pid) = child.id() {
            let _ = std::fs::write(&pid_file, pid.to_string());
        }
        // Nothing the bot's page starts is saved to this computer.
        let denied = pipe
            .call(
                "Browser.setDownloadBehavior",
                json!({ "behavior": "deny" }),
                None,
            )
            .await;
        let running = Running {
            pipe,
            attach: tokio::sync::Mutex::default(),
            child: Mutex::new(Some(child)),
        };
        if let Err(error) = denied {
            running.end();
            return Err(error);
        }
        Ok(running)
    }

    #[cfg(windows)]
    async fn start(&self, _program: &Path, _key: &str) -> Result<Running, String> {
        Err(NO_BROWSER.to_owned())
    }
}

/// A folder only this user can open.
#[cfg(unix)]
fn private_folder(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

/// Ends the browser an earlier app left on this profile (a crash on macOS), so the new one is not
/// handed to it: only a process whose command line still names this profile.
#[cfg(unix)]
fn end_leftover(pid_file: &Path, profile: &Path) {
    let Some(pid) = std::fs::read_to_string(pid_file)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
    else {
        return;
    };
    let marker = format!("--user-data-dir={}", profile.display());
    if command_line(pid).is_some_and(|line| line.contains(&marker)) {
        crate::stack_os::end_leftover(pid, Duration::from_secs(5));
    }
    let _ = std::fs::remove_file(pid_file);
}

#[cfg(target_os = "linux")]
fn command_line(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(String::from_utf8_lossy(&raw).replace('\0', " "))
}

#[cfg(target_os = "macos")]
fn command_line(pid: u32) -> Option<String> {
    crate::stack_os::program_of(pid)
}

/// Starts the browser with the pipe on its fds 3 (commands in) and 4 (answers out).
#[cfg(unix)]
async fn launch(
    program: &Path,
    args: &[String],
) -> std::io::Result<(tokio::process::Child, Arc<Pipe>)> {
    use std::os::fd::{AsRawFd, OwnedFd};
    let (commands_in, commands_out) = std::io::pipe()?;
    let (answers_in, answers_out) = std::io::pipe()?;
    let (browser_reads, browser_writes) = (commands_in.as_raw_fd(), answers_out.as_raw_fd());
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::stack_os::prepare(&mut command, crate::stack_os::Stop::Terminate, None);
    // SAFETY: between fork and exec only async-signal-safe calls (fcntl, dup2, close).
    unsafe {
        command.pre_exec(move || {
            // Moved above 4 first, so placing one cannot overwrite the other.
            let reads = libc::fcntl(browser_reads, libc::F_DUPFD, 10);
            let writes = libc::fcntl(browser_writes, libc::F_DUPFD, 10);
            if reads < 0 || writes < 0 || libc::dup2(reads, 3) < 0 || libc::dup2(writes, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(reads);
            libc::close(writes);
            Ok(())
        });
    }
    let child = crate::stack_os::spawn(command).await?;
    // The browser holds its ends now; with ours closed, its exit closes the pipe here.
    drop((commands_in, answers_out));
    let to_browser = tokio::net::unix::pipe::Sender::from_owned_fd(OwnedFd::from(commands_out))?;
    let from_browser = tokio::net::unix::pipe::Receiver::from_owned_fd(OwnedFd::from(answers_in))?;
    Ok((child, Pipe::start(Box::new(to_browser), from_browser)))
}

#[cfg(all(test, unix))]
#[path = "browser_e2e.rs"]
mod e2e;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};

    #[test]
    fn it_starts_with_a_profile_of_its_own_and_none_of_the_flags_that_weaken_it() {
        let args = arguments(Path::new("/data/browser-profiles/abc"), false);
        assert_eq!(args[0], "--user-data-dir=/data/browser-profiles/abc");
        assert!(args.contains(&"--remote-debugging-pipe".to_owned()));
        for forbidden in [
            "--enable-automation",
            "--use-mock-keychain",
            "--password-store",
            "--app",
            "--kiosk",
            "--remote-debugging-port",
            "--headless",
        ] {
            assert!(
                !args.iter().any(|arg| arg.starts_with(forbidden)),
                "{forbidden} in {args:?}"
            );
        }
        assert!(arguments(Path::new("/p"), true).contains(&"--headless=new".to_owned()));
    }

    #[test]
    fn it_passes_on_only_allowed_commands_and_parameters() {
        let ok = allowed(&json!({ "method": "Input.insertText", "params": { "text": "hi" } }));
        assert_eq!(
            ok.unwrap(),
            ("Input.insertText".to_owned(), json!({ "text": "hi" }))
        );
        assert_eq!(
            allowed(&json!({ "method": "Page.enable" })).unwrap().1,
            json!({})
        );
        for refused in [
            json!({ "method": "Runtime.evaluate", "params": { "expression": "document.cookie" } }),
            json!({ "method": "Network.getCookies" }),
            json!({ "method": "Network.getAllCookies" }),
            json!({ "method": "Storage.getCookies" }),
            json!({ "method": "DOMStorage.getDOMStorageItems" }),
            json!({ "method": "IndexedDB.requestData" }),
            json!({ "method": "Runtime.callFunctionOn" }),
            json!({ "method": "Target.attachToTarget", "params": { "targetId": "x" } }),
            json!({ "method": "Browser.setDownloadBehavior", "params": { "behavior": "allow" } }),
            json!({ "method": "DOM.setFileInputFiles" }),
            json!({ "method": "DOM.resolveNode" }),
            json!({ "method": "Page.addScriptToEvaluateOnNewDocument" }),
            json!({ "method": "Page.navigate", "params": { "url": "javascript:alert(1)" } }),
            json!({ "method": "Page.navigate", "params": { "url": "file:///etc/passwd" } }),
            json!({ "method": "Page.navigate", "params": { "url": "chrome://settings/passwords" } }),
            json!({ "method": "Page.navigate", "params": { "url": "data:text/html,x" } }),
            json!({ "method": "Page.navigate", "params": {} }),
            json!({ "method": "Page.navigate", "params": { "url": "https://x.test", "frameId": "f" } }),
            json!({ "method": "Input.insertText", "params": "text" }),
            json!({ "params": {} }),
            json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "keyDown", "key": "v", "modifiers": 2 } }),
            json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "rawKeyDown", "code": "KeyV", "modifiers": 4 } }),
            json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "keyDown", "windowsVirtualKeyCode": 45, "modifiers": 8 } }),
            json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "keyDown", "key": "a", "commands": ["paste"] } }),
        ] {
            assert!(allowed(&refused).is_err(), "passed: {refused}");
        }
        for url in [
            "https://example.test/a?b",
            "http://127.0.0.1:8080/",
            "about:blank",
        ] {
            let navigate = json!({ "method": "Page.navigate", "params": { "url": url } });
            assert!(allowed(&navigate).is_ok(), "{url}");
        }
        let typed = json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "keyDown", "key": "v", "modifiers": 8 } });
        assert!(allowed(&typed).is_ok(), "Shift+V is a capital V");
    }

    /// A browser stand-in on the other end of an in-memory pipe: answers each command with
    /// `answer`, after sending `before` events.
    fn fake(answer: impl Fn(&Value) -> Value + Send + 'static, before: Vec<Value>) -> Arc<Pipe> {
        let (ours, theirs): (DuplexStream, DuplexStream) = duplex(1 << 20);
        let (ours_read, ours_write) = tokio::io::split(ours);
        let (mut theirs_read, mut theirs_write) = tokio::io::split(theirs);
        tokio::spawn(async move {
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            while let Ok(read) = theirs_read.read(&mut chunk).await {
                if read == 0 {
                    return;
                }
                buffer.extend_from_slice(&chunk[..read]);
                while let Some(end) = buffer.iter().position(|byte| *byte == 0) {
                    let message: Vec<u8> = buffer.drain(..=end).collect();
                    let request: Value = serde_json::from_slice(&message[..end]).unwrap();
                    for event in &before {
                        let mut bytes = event.to_string().into_bytes();
                        bytes.push(0);
                        theirs_write.write_all(&bytes).await.unwrap();
                    }
                    let mut reply = answer(&request);
                    reply["id"] = request["id"].clone();
                    let mut bytes = reply.to_string().into_bytes();
                    bytes.push(0);
                    theirs_write.write_all(&bytes).await.unwrap();
                }
            }
        });
        Pipe::start(Box::new(ours_write), ours_read)
    }

    #[tokio::test]
    async fn answers_come_back_by_id_and_only_the_bot_s_page_events_are_kept() {
        let events = vec![
            json!({ "method": "Page.loadEventFired", "sessionId": "page", "params": { "timestamp": 1 } }),
            json!({ "method": "Page.loadEventFired", "sessionId": "other", "params": {} }),
            json!({ "method": "Network.requestWillBeSent", "sessionId": "page", "params": {} }),
            json!({ "method": "Page.frameNavigated", "sessionId": "page", "params": { "frame": { "parentId": "p" } } }),
            json!({ "method": "Page.frameNavigated", "sessionId": "page", "params": { "frame": { "url": "https://a.test/" } } }),
        ];
        let pipe = fake(
            |request| json!({ "result": { "echo": request["method"], "session": request["sessionId"] } }),
            events,
        );
        *pipe.session.lock().unwrap() = Some("page".to_owned());
        let result = pipe
            .call("Page.getFrameTree", json!({}), Some("page"))
            .await
            .unwrap();
        assert_eq!(
            result,
            json!({ "echo": "Page.getFrameTree", "session": "page" })
        );
        let kept = pipe.take_events();
        assert_eq!(kept.len(), 2, "{kept:?}");
        assert_eq!(kept[0]["method"], "Page.loadEventFired");
        assert_eq!(kept[1]["params"]["frame"]["url"], "https://a.test/");
        assert!(pipe.take_events().is_empty());
    }

    #[tokio::test]
    async fn a_refusal_from_the_browser_is_an_error_and_a_detached_page_is_forgotten() {
        let pipe = fake(
            |_| json!({ "error": { "code": -32000, "message": "No node with given id" } }),
            vec![
                json!({ "method": "Target.detachedFromTarget", "params": { "sessionId": "page" } }),
            ],
        );
        *pipe.session.lock().unwrap() = Some("page".to_owned());
        let error = pipe
            .call("DOM.getBoxModel", json!({}), Some("page"))
            .await
            .unwrap_err();
        assert!(error.contains("No node with given id"), "{error}");
        assert!(pipe.session.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn a_closed_pipe_fails_what_waits_and_what_comes_after() {
        let (ours, theirs) = duplex(1024);
        let (ours_read, ours_write) = tokio::io::split(ours);
        let pipe = Pipe::start(Box::new(ours_write), ours_read);
        let waiting = {
            let pipe = pipe.clone();
            tokio::spawn(async move { pipe.call("Page.enable", json!({}), None).await })
        };
        tokio::task::yield_now().await;
        drop(theirs);
        assert_eq!(waiting.await.unwrap().unwrap_err(), CLOSED);
        assert_eq!(
            pipe.call("Page.enable", json!({}), None).await.unwrap_err(),
            CLOSED
        );
    }

    #[tokio::test]
    async fn without_a_browser_it_says_so_and_still_refuses_what_is_not_allowed() {
        let dir = std::env::temp_dir().join(format!("dozo-browser-none-{}", std::process::id()));
        let browsers = Browsers::with(dir, None, true);
        assert!(!browsers.available());
        let enable = json!({ "method": "Page.enable" });
        assert_eq!(browsers.handle("k", &enable).await.unwrap_err(), NO_BROWSER);
        let evaluate = json!({ "method": "Runtime.evaluate" });
        let refused = browsers.handle("k", &evaluate).await.unwrap_err();
        assert!(refused.starts_with("Not allowed"), "{refused}");
    }
}
