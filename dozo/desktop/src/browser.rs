//! The bot's own browser on this computer: a Chromium-family browser already installed here
//! (Chrome, Edge, Brave or Chromium), started with a profile folder of the bot's own, never the
//! person's, in a normal window with its address bar. The server drives the page through the
//! DevTools protocol (`pageBrowser` requests), and only over a pipe: no TCP port is opened, so
//! nothing on the network and no program running as another user can connect to it. This side passes on only the commands in
//! `ALLOWED`, with only the parameters listed there, to the bot's one page; it never passes on
//! what reads cookies or site storage, or runs script (`Runtime.evaluate`), so neither reaches
//! the server. Downloads are refused.
//!
//! The browser ends with the app: on Linux the kernel ends it when the app ends however it ends
//! (`stack_os::prepare`); everywhere the closed pipe ends it, and a profile's last browser is
//! ended before the next one starts (`end_leftover`). Windows: not yet (`find` finds none).
//!
//! The honest limit: anything running as this user, a bot's own commands included, can read the
//! profile folder, and on Linux can open the browser's pipe through `/proc` and send it any
//! command. The allowlist holds the server's channel, not this user's own programs.

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
    // The visible page only: a full-length capture can outgrow any answer. No bringToFront: it
    // would take the keyboard from the app the person is typing in.
    ("Page.captureScreenshot", &["format", "quality"]),
    ("Page.getLayoutMetrics", &[]),
    ("Page.getFrameTree", &[]),
    ("Page.handleJavaScriptDialog", &["accept", "promptText"]),
];

/// Parameters that must be whole numbers of zero or more when given: anything else (`2.0`, `-1`)
/// could read differently here and in the browser.
const WHOLE: &[&str] = &[
    "depth",
    "backendNodeId",
    "buttons",
    "clickCount",
    "modifiers",
    "windowsVirtualKeyCode",
    "nativeVirtualKeyCode",
    "location",
    "entryId",
    "quality",
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

/// Whether this app has a browser for bots. Off until the sign-in pause comes (the person signs in
/// while the app passes on nothing). While off, the app does not declare it to servers
/// (`device_socket.rs`) and refuses a `pageBrowser` a server sends anyway, before any browser is
/// looked for or started (`device_run.rs`), so only this module's own tests reach it.
pub const DECLARED: bool = false;

/// Asks the person to sign in to a site in the bot's browser window; answers true once they say
/// they are done, false when they cancel. Only the person can answer: nothing the server or the
/// bot sends ends it.
pub trait SignInPrompt: Send + Sync {
    fn ask(&self, site: &str) -> oneshot::Receiver<bool>;
    /// The sign-in ended without the person's answer (the time ran out, the browser closed or the
    /// bot was deleted): they are told the bot has its browser again.
    fn ended(&self, site: &str);
}

/// How long a sign-in may wait for the person before it counts as cancelled.
const SIGN_IN_TIME: Duration = Duration::from_secs(15 * 60);

pub const NO_BROWSER: &str = "No supported browser is installed on this computer.";
const CLOSED: &str = "The bot's browser closed.";

/// The browser this computer would start, if any: the first of Chrome, Edge, Brave and Chromium,
/// looked for only where the system installs them, never in a folder on `PATH` or in the home
/// folder, which any program running as this user could fill. A Snap package is passed over: it
/// cannot use a profile folder inside the app's data.
#[cfg(target_os = "macos")]
pub fn find() -> Option<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
}

#[cfg(target_os = "linux")]
pub fn find() -> Option<PathBuf> {
    [
        "/opt/google/chrome/chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/opt/microsoft/msedge/msedge",
        "/usr/bin/microsoft-edge-stable",
        "/usr/bin/microsoft-edge",
        "/opt/brave.com/brave/brave",
        "/usr/bin/brave-browser",
        "/usr/lib/chromium/chromium",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|candidate| {
        let real = std::fs::canonicalize(candidate).unwrap_or_default();
        is_executable(candidate) && !real.starts_with("/snap/")
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
fn arguments(profile: &Path, headless: bool, proxy: u16) -> Vec<String> {
    let mut args = vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-pipe".to_owned(),
        "--no-first-run".to_owned(),
        "--no-default-browser-check".to_owned(),
        // Every request through this app's proxy (`browser_proxy.rs`), loopback included, which
        // the browser would otherwise reach directly, and no WebRTC traffic around it.
        format!("--proxy-server=http://127.0.0.1:{proxy}"),
        "--proxy-bypass-list=<-loopback>".to_owned(),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_owned(),
    ];
    if headless {
        args.push("--headless=new".to_owned());
    }
    args.push("about:blank".to_owned());
    args
}

/// Checks one command from the server and keeps only the parameters it may carry. `local`: pages
/// on this computer or its network may be opened (tests only).
pub fn allowed(command: &Value, local: bool) -> Result<(String, Value), String> {
    let method = command
        .get("method")
        .and_then(Value::as_str)
        .ok_or("pageBrowser needs a method")?;
    let Some((_, keys)) = ALLOWED.iter().find(|(name, _)| *name == method) else {
        return Err(format!("Not allowed in the bot's browser: {method}"));
    };
    let mut given = match command.get("params") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(params)) => params.clone(),
        Some(_) => return Err("pageBrowser params must be an object".to_owned()),
    };
    if let Some(extra) = given.keys().find(|key| !keys.contains(&key.as_str())) {
        return Err(format!(
            "Not allowed in the bot's browser: {method} {extra}"
        ));
    }
    if let Some(bad) = WHOLE.iter().find(|key| {
        given
            .get(**key)
            .is_some_and(|value| value.as_u64().is_none())
    }) {
        return Err(format!("pageBrowser {bad} must be a whole number"));
    }
    if method == "Page.navigate" {
        let url = given.get("url").and_then(Value::as_str).unwrap_or_default();
        if !web_address(url, local) {
            return Err(NOT_WEB.to_owned());
        }
    }
    if method == "Input.dispatchKeyEvent" && shortcut(&given) {
        return Err("Not allowed in the bot's browser: that key".to_owned());
    }
    // With Ctrl, Cmd or Alt held, only the key itself is sent: no text, and no system key code,
    // which macOS reads as a shortcut of its own.
    let held = given.get("modifiers").and_then(Value::as_u64).unwrap_or(0) & (1 | 2 | 4) != 0;
    if method == "Input.dispatchKeyEvent" && held {
        for field in ["text", "unmodifiedText", "nativeVirtualKeyCode"] {
            given.remove(field);
        }
    }
    // A middle click pastes what the person last selected anywhere (Linux); the back and forward
    // buttons leave the page.
    let button = given.get("button").and_then(Value::as_str);
    let other = matches!(button, Some("middle" | "back" | "forward"))
        || given.get("buttons").and_then(Value::as_u64).unwrap_or(0) & (4 | 8 | 16) != 0;
    if method == "Input.dispatchMouseEvent" && other {
        return Err("Not allowed in the bot's browser: that mouse button".to_owned());
    }
    Ok((method.to_owned(), Value::Object(given)))
}

const NOT_WEB: &str = "The bot's browser opens only websites: http and https addresses outside this computer and its network";

/// An address a page may be sent to or used on: a blank page, or http and https on a host outside
/// this computer and its network. Never `javascript:`, `file:`, `data:`, the browser's own pages,
/// loopback, link-local, private or `.local` hosts (with `local`, those hosts too: tests only). A
/// public name that resolves to a private address is not caught.
fn web_address(url: &str, local: bool) -> bool {
    if url == "about:blank" {
        return true;
    }
    let Ok(url) = tauri::Url::parse(url) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    local || crate::browser_proxy::public_host(host.trim_start_matches('[').trim_end_matches(']'))
}

/// A key press that reaches more than the page's text: the clipboard (Ctrl or Cmd with V, C or X,
/// Shift with Insert or Delete, Ctrl with Insert), or the browser's own shortcuts (Alt with anything, Ctrl
/// or Cmd with anything but select all, undo and the editing keys, the function keys and the
/// browser and media keys).
fn shortcut(params: &Map<String, Value>) -> bool {
    let modifiers = params.get("modifiers").and_then(Value::as_u64).unwrap_or(0);
    let names: Vec<String> = ["key", "code"]
        .iter()
        .filter_map(|field| params.get(*field).and_then(Value::as_str))
        .map(|name| name.to_ascii_lowercase())
        .collect();
    let code = params.get("windowsVirtualKeyCode").and_then(Value::as_u64);
    let browser_key = names.iter().any(|name| {
        name.starts_with("browser")
            || name.starts_with("launch")
            || name.starts_with("media")
            || name.starts_with("audio")
            || (name.len() > 1 && name.starts_with('f') && name[1..].parse::<u8>().is_ok())
    }) || code
        .is_some_and(|code| (112..=135).contains(&code) || (166..=183).contains(&code));
    // The keyboards' own Copy, Cut and Paste keys act on the clipboard with no modifier.
    let clipboard_key = names
        .iter()
        .any(|name| matches!(name.as_str(), "copy" | "cut" | "paste"));
    if browser_key || clipboard_key || modifiers & 1 != 0 {
        return true;
    }
    // Shift+Insert pastes, Shift+Delete cuts and Ctrl+Insert copies.
    let insert = names.iter().any(|name| name == "insert") || code == Some(45);
    let delete = names.iter().any(|name| name == "delete") || code == Some(46);
    if (modifiers & 8 != 0 && (insert || delete)) || (modifiers & (2 | 4) != 0 && insert) {
        return true;
    }
    if modifiers & (2 | 4) == 0 {
        return false;
    }
    // With Ctrl or Cmd: only select all, undo and moving or deleting by word.
    const EDITING: &[(&str, &str, u64)] = &[
        ("a", "keya", 65),
        ("z", "keyz", 90),
        ("backspace", "backspace", 8),
        ("delete", "delete", 46),
        ("arrowleft", "arrowleft", 37),
        ("arrowright", "arrowright", 39),
        ("arrowup", "arrowup", 38),
        ("arrowdown", "arrowdown", 40),
        ("home", "home", 36),
        ("end", "end", 35),
    ];
    let known = |name: &String| {
        EDITING
            .iter()
            .any(|(key, code, _)| name == key || name == code)
    };
    // Cmd with an arrow goes back or forward on macOS.
    let command_arrow = modifiers & 4 != 0
        && (names.iter().any(|name| name.starts_with("arrow"))
            || code.is_some_and(|code| (37..=40).contains(&code)));
    // With Shift too, only selecting by word or line and redo: Ctrl+Shift+Delete clears the
    // browsing data.
    let shifted_delete = modifiers & 8 != 0
        && (names
            .iter()
            .any(|name| ["backspace", "delete", "a", "keya"].contains(&name.as_str()))
            || code.is_some_and(|code| [8, 46, 65].contains(&code)));
    let identified = !names.is_empty() || code.is_some();
    !identified
        || command_arrow
        || shifted_delete
        || !names.iter().all(known)
        || code.is_some_and(|code| !EDITING.iter().any(|(_, _, editing)| *editing == code))
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
        // Only the new bytes can end a message: what came before had no NUL.
        let mut scanned = buffer.len();
        buffer.extend_from_slice(&chunk[..read]);
        while let Some(found) = buffer[scanned..].iter().position(|byte| *byte == 0) {
            let end = scanned + found;
            if let Ok(message) = serde_json::from_slice::<Value>(&buffer[..end]) {
                if message["method"] == "Target.attachedToTarget" {
                    let params = message["params"].clone();
                    tokio::spawn(guard_target(Arc::downgrade(&pipe), params));
                }
                pipe.receive(message);
            }
            buffer.drain(..=end);
            scanned = 0;
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
    /// The bot's page, once attached.
    target: Mutex<Option<String>>,
    /// History entries up to this id were made while the person signed in (with what came
    /// before): the server gets them without address or title.
    hidden_through: AtomicU64,
    #[cfg(unix)]
    child: Mutex<Option<tokio::process::Child>>,
}

impl Running {
    /// The bot's page. The first time, the tab the browser opened with (a blank page; a tab of
    /// the browser's own pages or this computer's files is never taken). Once that tab is gone
    /// (the person closed it), always a new blank tab: never another tab, which may be the person's
    /// own or a window a page opened.
    async fn page(&self, local: bool) -> Result<String, String> {
        let _attaching = self.attach.lock().await;
        if let Some(session) = self.pipe.session.lock().unwrap().clone() {
            return Ok(session);
        }
        let mut target = None;
        let first = self.target.lock().unwrap().is_none();
        for _ in 0..if first { 50 } else { 0 } {
            let targets = self.pipe.call("Target.getTargets", json!({}), None).await?;
            let pages: Vec<&Value> = targets["targetInfos"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|info| info["type"] == "page")
                .collect();
            target = pages
                .iter()
                .find(|info| web_address(info["url"].as_str().unwrap_or(""), local))
                .and_then(|info| info["targetId"].as_str().map(str::to_owned));
            // The browser's first tab can take a moment; other tabs mean it is ready.
            if target.is_some() || !pages.is_empty() {
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
        *self.target.lock().unwrap() = Some(target);
        self.pipe
            .call("Page.enable", json!({}), Some(&session))
            .await?;
        // This app's own guard, never the server's: in every document the page opens from now on,
        // and in the one it shows.
        let guard = json!({ "source": GUARD });
        self.pipe
            .call(
                "Page.addScriptToEvaluateOnNewDocument",
                guard,
                Some(&session),
            )
            .await?;
        let now = json!({ "expression": GUARD });
        self.pipe
            .call("Runtime.evaluate", now, Some(&session))
            .await?;
        Ok(session)
    }

    /// The address the bot's page shows now, as the browser has it.
    async fn address(&self) -> Result<String, String> {
        let target = self.target.lock().unwrap().clone().ok_or(CLOSED)?;
        let info = self
            .pipe
            .call("Target.getTargetInfo", json!({ "targetId": target }), None)
            .await?;
        Ok(info["targetInfo"]["url"].as_str().unwrap_or("").to_owned())
    }

    /// Ends the browser; true once it has ended, so its profile is free.
    async fn end_and_wait(&self) -> bool {
        self.pipe.close();
        #[cfg(unix)]
        {
            let child = self.child.lock().unwrap().take();
            if let Some(mut child) = child {
                crate::stack_os::kill(&mut child);
                let ended = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
                return matches!(ended, Ok(Ok(_)));
            }
        }
        true
    }

    fn end(&self) {
        self.pipe.close();
        #[cfg(unix)]
        if let Some(mut child) = self.child.lock().unwrap().take() {
            crate::stack_os::kill(&mut child);
        }
    }
}

fn signing_message(site: &str) -> String {
    format!(
        "The person is signing in to {site} in the bot's browser; nothing reaches it until they are done."
    )
}

/// The site a sign-in opens: a registrable domain or host on the web, lower case, nothing more
/// (tests may name a loopback host and port).
fn sign_in_site(site: &str, local: bool) -> Option<String> {
    let site = site.trim().trim_end_matches('/').to_ascii_lowercase();
    let allowed =
        |c: char| c.is_ascii_alphanumeric() || c == '.' || c == '-' || (local && c == ':');
    (!site.is_empty() && site.chars().all(allowed) && !site.starts_with(['.', '-']))
        .then(|| site.clone())
        .filter(|site| web_address(&format!("https://{site}/"), local))
}

const OFF_THE_WEB: &str = "The bot's page shows no website now (a page of the browser or of this computer). Open a website with Page.navigate first.";

/// Every bot's browser on this computer, each with its own profile under `root`.
pub struct Browsers {
    root: PathBuf,
    program: Option<PathBuf>,
    headless: bool,
    /// Pages on this computer and its network may be opened: tests only, which serve their page
    /// on loopback.
    local: bool,
    /// What of them the proxy lets through, for those tests.
    local_hosts: crate::browser_proxy::Local,
    open: Mutex<HashMap<String, Arc<Running>>>,
    /// The bots' browsers' only way out, started with the first of them.
    proxy: tokio::sync::Mutex<Option<crate::browser_proxy::Proxy>>,
    /// The person's sign-in prompt; the app sets it.
    prompt: std::sync::OnceLock<Arc<dyn SignInPrompt>>,
    /// Bots whose browser the person is signing in with, by key, with the site.
    signing: Mutex<HashMap<String, String>>,
    /// Told when the first sign-in starts (true) and the last one ends (false): the app holds
    /// every bot's commands on this computer meanwhile.
    on_pause: std::sync::OnceLock<Box<dyn Fn(bool) + Send + Sync>>,
    /// How long a sign-in waits for the person (`SIGN_IN_TIME`; tests shorten it).
    sign_in_time: Duration,
    /// One start at a time.
    starting: tokio::sync::Mutex<()>,
    /// Moves on with every `close` and `close_all`, so a browser that was starting meanwhile is
    /// ended.
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
            local: false,
            local_hosts: crate::browser_proxy::Local::None,
            open: Mutex::default(),
            proxy: tokio::sync::Mutex::default(),
            prompt: std::sync::OnceLock::new(),
            signing: Mutex::default(),
            on_pause: std::sync::OnceLock::new(),
            sign_in_time: SIGN_IN_TIME,
            starting: tokio::sync::Mutex::default(),
            generation: AtomicU64::new(0),
        }
    }

    /// Lets tests open the page they serve on loopback.
    #[cfg(test)]
    pub fn with_local_pages(mut self) -> Self {
        self.local = true;
        self.local_hosts = crate::browser_proxy::Local::All;
        self
    }

    /// Marks a bot as signing in, or no longer, for tests of what the pause holds back.
    #[cfg(test)]
    pub fn mark_signing(&self, key: &str, site: Option<&str>) {
        match site {
            Some(site) => self.start_signing(key, site),
            None => self.stop_signing(key),
        }
    }

    /// Shortens how long a sign-in waits, for tests.
    #[cfg(test)]
    pub fn with_sign_in_time(mut self, time: Duration) -> Self {
        self.sign_in_time = time;
        self
    }

    /// Whom to tell when sign-ins start and end (`on_pause`).
    pub fn set_on_pause(&self, tell: Box<dyn Fn(bool) + Send + Sync>) {
        let _ = self.on_pause.set(tell);
    }

    /// Whether the person is signing in with any bot's browser on this computer.
    pub fn anyone_signing(&self) -> Option<String> {
        self.signing.lock().unwrap().values().next().cloned()
    }

    fn start_signing(&self, key: &str, site: &str) {
        let first = {
            let mut signing = self.signing.lock().unwrap();
            let first = signing.is_empty();
            signing.insert(key.to_owned(), site.to_owned());
            first
        };
        if let (true, Some(tell)) = (first, self.on_pause.get()) {
            tell(true);
        }
    }

    fn stop_signing(&self, key: &str) {
        let last = {
            let mut signing = self.signing.lock().unwrap();
            signing.remove(key).is_some() && signing.is_empty()
        };
        if let (true, Some(tell)) = (last, self.on_pause.get()) {
            tell(false);
        }
    }

    /// Lets tests open only the loopback ports they name, as pages and through the proxy.
    #[cfg(test)]
    pub fn with_local_ports(mut self, ports: Vec<u16>) -> Self {
        self.local = true;
        self.local_hosts = crate::browser_proxy::Local::Ports(ports);
        self
    }

    pub fn available(&self) -> bool {
        self.program.is_some()
    }

    /// The site the person is signing in to with this bot's browser, if they are.
    pub fn signing_site(&self, key: &str) -> Option<String> {
        self.signing.lock().unwrap().get(key).cloned()
    }

    /// The prompt the person answers when they sign in (`sign_in`).
    pub fn set_sign_in_prompt(&self, prompt: Arc<dyn SignInPrompt>) {
        let _ = self.prompt.set(prompt);
    }

    /// The person signs in to `site` in the bot's browser: its home page opens (never an address
    /// the bot names), and until the person says they are done or cancel, every command is
    /// refused, so the server sees nothing of it: no page, no screenshot, no address, no event.
    /// What the page did meanwhile is dropped. Answers whether they say they signed in. Ending
    /// the request does not end it: only the person does.
    pub async fn sign_in(&self, key: &str, site: &str) -> Result<bool, String> {
        let site = sign_in_site(site, self.local).ok_or(NOT_WEB)?;
        let prompt = self
            .prompt
            .get()
            .cloned()
            .ok_or("Signing in is not available here.")?;
        let running = self.running(key).await?;
        let session = running.page(self.local).await?;
        if let Some(already) = self.signing_site(key) {
            return Err(signing_message(&already));
        }
        self.start_signing(key, &site);
        let scheme = if self.local { "http" } else { "https" };
        let home = json!({ "url": format!("{scheme}://{site}/") });
        let opened = running
            .pipe
            .call("Page.navigate", home, Some(&session))
            .await;
        let answer = match opened {
            Ok(_) => {
                let mut answered = prompt.ask(&site);
                let deadline = tokio::time::Instant::now() + self.sign_in_time;
                // A browser that closed meanwhile ends it too: there is nothing to sign in with.
                // So does the time running out, or the bot being deleted (`close`): the sign-in
                // counts as cancelled, and the person is told.
                loop {
                    tokio::select! {
                        done = &mut answered => break done.unwrap_or(false),
                        () = tokio::time::sleep(Duration::from_millis(250)) => {
                            let ended = tokio::time::Instant::now() >= deadline
                                || !running.pipe.open.load(Ordering::SeqCst)
                                || self.signing_site(key).is_none();
                            if ended {
                                prompt.ended(&site);
                                break false;
                            }
                        }
                    }
                }
            }
            Err(_) => false,
        };
        // The addresses the sign-in went through (a code in a return address) stay out of what the
        // server reads: its events are dropped, and the history it made keeps no address.
        if let Ok(history) = running
            .pipe
            .call("Page.getNavigationHistory", json!({}), Some(&session))
            .await
        {
            let last = history["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| entry["id"].as_u64())
                .max()
                .unwrap_or(0);
            running.hidden_through.fetch_max(last, Ordering::SeqCst);
        }
        // Before the bot has the page again, it leaves where the sign-in left it: the site's home
        // page once the person is done, a blank page when they cancelled (a typed address or a
        // half-done second step stays theirs).
        let after = if answer {
            format!("{scheme}://{site}/")
        } else {
            "about:blank".to_owned()
        };
        let _ = running
            .pipe
            .call("Page.navigate", json!({ "url": &after }), Some(&session))
            .await;
        for _ in 0..100 {
            if running.address().await.is_ok_and(|now| now == after) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // The tab keeps no way back into the sign-in: a page that goes back (`history.go`), or a
        // Back link the bot clicks, finds nothing behind it.
        let _ = running
            .pipe
            .call("Page.resetNavigationHistory", json!({}), Some(&session))
            .await;
        running.pipe.take_events();
        self.stop_signing(key);
        Ok(answer)
    }

    /// Runs one allowed command on the bot's page, starting its browser when none runs, and
    /// answers with the result and the page events since the last answer. Only going to a website
    /// works while the page shows anything else.
    pub async fn handle(&self, key: &str, command: &Value) -> Result<Value, String> {
        let (method, params) = allowed(command, self.local)?;
        if let Some(site) = self.signing_site(key) {
            return Err(signing_message(&site));
        }
        let running = self.running(key).await?;
        let session = match running.page(self.local).await {
            Ok(session) => session,
            Err(error) => {
                self.forget(key, &running);
                return Err(error);
            }
        };
        // A tab still on its first, empty document while it loads a page shows no address yet.
        let address = running.address().await?;
        if method != "Page.navigate" && !address.is_empty() && !web_address(&address, self.local) {
            running.pipe.take_events();
            return Err(OFF_THE_WEB.to_owned());
        }
        if method == "Page.navigateToHistoryEntry" {
            let history = running
                .pipe
                .call("Page.getNavigationHistory", json!({}), Some(&session))
                .await?;
            let entry = history["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|entry| entry["id"] == params["entryId"]);
            let url = entry.and_then(|entry| entry["url"].as_str()).unwrap_or("");
            let hidden = running.hidden_through.load(Ordering::SeqCst);
            let made_signing_in = entry
                .and_then(|entry| entry["id"].as_u64())
                .is_some_and(|id| id <= hidden);
            if !web_address(url, self.local) || made_signing_in {
                return Err(NOT_WEB.to_owned());
            }
        }
        if self.signing_site(key).is_some() {
            return Err(signing_message(&self.signing_site(key).unwrap_or_default()));
        }
        let result = running.pipe.call(&method, params, Some(&session)).await;
        // A sign-in that started while the command ran keeps what it read.
        if let Some(site) = self.signing_site(key) {
            running.pipe.take_events();
            return Err(signing_message(&site));
        }
        if !running.pipe.open.load(Ordering::SeqCst) {
            self.forget(key, &running);
        }
        let mut result = result?;
        // The page may have left the web while the command ran (a click on a link, a redirect):
        // then what the command read is dropped.
        let after = running.address().await?;
        if !after.is_empty() && !web_address(&after, self.local) {
            running.pipe.take_events();
            return Err(OFF_THE_WEB.to_owned());
        }
        if method == "Page.getNavigationHistory" {
            let hidden = running.hidden_through.load(Ordering::SeqCst);
            hide_off_web_entries(&mut result, self.local, hidden);
        }
        let events: Vec<Value> = running
            .pipe
            .take_events()
            .into_iter()
            .filter(|event| {
                event["method"] != "Page.frameNavigated"
                    || web_address(
                        event["params"]["frame"]["url"].as_str().unwrap_or(""),
                        self.local,
                    )
            })
            .collect();
        Ok(json!({ "result": result, "events": events }))
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

    /// Ends the bot's browser. `forget_profile` also removes its profile (the bot is gone), once
    /// the browser has ended, so it cannot write it back.
    pub async fn close(&self, key: &str, forget_profile: bool) {
        // Only the person ends a sign-in: stopping the bot leaves its browser open meanwhile.
        // Deleting it ends the sign-in (the person is told) and then the browser and profile go.
        if self.signing_site(key).is_some() {
            if !forget_profile {
                return;
            }
            self.stop_signing(key);
        }
        let running = {
            let mut open = self.open.lock().unwrap();
            // A browser starting meanwhile is ended rather than kept.
            self.generation.fetch_add(1, Ordering::SeqCst);
            open.remove(key)
        };
        let ended = match running {
            Some(running) => running.end_and_wait().await,
            None => true,
        };
        // A browser that would not end keeps its profile: removing it under a running browser
        // could leave half of it written back.
        if forget_profile && ended {
            let (root, key) = (self.root.clone(), key.to_owned());
            let _ = tokio::task::spawn_blocking(move || {
                let _ = std::fs::remove_dir_all(root.join(&key));
                let _ = std::fs::remove_file(root.join(format!("{key}.pid")));
            })
            .await;
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
        let (pid, marked) = (pid_file.clone(), profile.clone());
        let _ = tokio::task::spawn_blocking(move || end_leftover(&pid, &marked)).await;
        let proxy = {
            let mut proxy = self.proxy.lock().await;
            if proxy.is_none() {
                let started = crate::browser_proxy::Proxy::start(self.local_hosts.clone()).await;
                *proxy = Some(started.map_err(|_| "The bot's browser could not start".to_owned())?);
            }
            proxy.as_ref().map_or(0, |proxy| proxy.port)
        };
        let (child, pipe) = launch(program, &arguments(&profile, self.headless, proxy))
            .await
            .map_err(|_| "The bot's browser could not start".to_owned())?;
        if let Some(pid) = child.id() {
            let _ = std::fs::write(&pid_file, pid.to_string());
        }
        let running = Running {
            pipe,
            attach: tokio::sync::Mutex::default(),
            target: Mutex::default(),
            hidden_through: AtomicU64::new(0),
            child: Mutex::new(Some(child)),
        };
        if let Err(error) = harden(&running.pipe).await {
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

/// What the browser is told before the bot's page is used: nothing it starts is saved to this
/// computer (downloads denied), and no page reads or writes the clipboard through its API.
async fn harden(pipe: &Pipe) -> Result<(), String> {
    pipe.call(
        "Browser.setDownloadBehavior",
        json!({ "behavior": "deny" }),
        None,
    )
    .await?;
    for name in ["clipboard-write", "clipboard-read"] {
        let denied = json!({ "permission": { "name": name }, "setting": "denied" });
        pipe.call("Browser.setPermission", denied, None).await?;
    }
    // Nothing a page asks the person through the browser's own prompts. A name an older browser
    // does not know is left: the guard refuses those features anyway.
    for name in [
        "notifications",
        "geolocation",
        "camera",
        "microphone",
        "midi",
        "window-management",
        "local-fonts",
        "idle-detection",
        "storage-access",
    ] {
        let denied = json!({ "permission": { "name": name }, "setting": "denied" });
        let _ = pipe.call("Browser.setPermission", denied, None).await;
    }
    // Every new tab or window holds before its first script until it has the guard
    // (`guard_target`).
    pipe.call("Target.setAutoAttach", AUTO_ATTACH.clone(), None)
        .await?;
    Ok(())
}

static AUTO_ATTACH: std::sync::LazyLock<Value> = std::sync::LazyLock::new(
    || json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }),
);

/// Puts the guard into a tab, window or frame of its own process the browser just made and holds
/// before its first script, then lets it run; its own frames are held the same way. A worker
/// only runs on: it has no document to guard.
async fn guard_target(pipe: std::sync::Weak<Pipe>, params: Value) {
    let Some(pipe) = pipe.upgrade() else { return };
    let Some(session) = params["sessionId"].as_str() else {
        return;
    };
    let waiting = params["waitingForDebugger"] == true;
    if matches!(
        params["targetInfo"]["type"].as_str(),
        Some("page" | "iframe")
    ) {
        // A frame of its own process takes the script for its documents only once enabled.
        let _ = pipe.call("Page.enable", json!({}), Some(session)).await;
        let new_documents = json!({ "source": GUARD });
        let _ = pipe
            .call(
                "Page.addScriptToEvaluateOnNewDocument",
                new_documents,
                Some(session),
            )
            .await;
        // One already running (there before the browser was told to hold new ones) gets it now;
        // one that holds has no script to run it yet, and would not answer until let go.
        if !waiting {
            let now = json!({ "expression": GUARD });
            let _ = pipe.call("Runtime.evaluate", now, Some(session)).await;
        }
        let _ = pipe
            .call("Target.setAutoAttach", AUTO_ATTACH.clone(), Some(session))
            .await;
    }
    if waiting {
        let _ = pipe
            .call("Runtime.runIfWaitingForDebugger", json!({}), Some(session))
            .await;
    }
}

/// A click the server sends counts as the person's gesture, so a page could use it to write the
/// clipboard, take the whole screen, or reach past the page. The permissions above stop the
/// clipboard API and the prompts; this stops the older copy and cut commands, every form of full
/// screen (a full screen that starts anyway, from a video's own controls, is left at once),
/// picture-in-picture windows, pointer lock, the file and folder pickers, printing, passkeys and
/// payment sheets. It is set in every document before its scripts (and in every new tab, window
/// and frame process, `guard_target`), and it guards a window a page opens and a frame it reaches.
/// A page cannot undo it: everything it relies on is taken before any page script runs, so a page
/// that later replaces `Function.prototype.call`, `Array.prototype.includes` or the like changes
/// nothing, and the browser's own functions stay out of its reach. A page that opens a window still
/// can (sign-ins need it): it opens as a tab the bot cannot reach.
const GUARD: &str = r#"(() => {
  const apply = Reflect.apply;
  const lower = String.prototype.toLowerCase;
  const text = String;
  const has = WeakSet.prototype.has;
  const add = WeakSet.prototype.add;
  const own = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  const listen = EventTarget.prototype.addEventListener;
  const guarded = new WeakSet();
  const guard = (w) => {
    try {
      if (!w || apply(has, guarded, [w])) return w;
      apply(add, guarded, [w]);
      const refuse = () => w.Promise.reject(new w.DOMException('Not allowed here', 'NotAllowedError'));
      const nothing = () => {};
      const set = (target, name, value) => {
        if (target && name in target) define(target, name, { value, writable: true, configurable: true });
      };
      const doc = w.Document.prototype;
      const exec = doc.execCommand;
      set(doc, 'execCommand', function () {
        const name = apply(lower, text(arguments[0]), []);
        if (name === 'copy' || name === 'cut' || name === 'paste') return false;
        return apply(exec, this, [name, arguments[1], arguments[2]]);
      });
      const element = w.Element.prototype;
      set(element, 'requestFullscreen', refuse);
      set(element, 'webkitRequestFullscreen', nothing);
      set(element, 'webkitRequestFullScreen', nothing);
      set(element, 'requestPointerLock', refuse);
      const video = w.HTMLVideoElement.prototype;
      set(video, 'webkitEnterFullscreen', nothing);
      set(video, 'webkitEnterFullScreen', nothing);
      set(video, 'requestPictureInPicture', refuse);
      if (w.DocumentPictureInPicture) set(w.DocumentPictureInPicture.prototype, 'requestWindow', refuse);
      set(w, 'showOpenFilePicker', refuse);
      set(w, 'showSaveFilePicker', refuse);
      set(w, 'showDirectoryPicker', refuse);
      set(w, 'print', nothing);
      if (w.CredentialsContainer) {
        set(w.CredentialsContainer.prototype, 'get', refuse);
        set(w.CredentialsContainer.prototype, 'create', refuse);
      }
      if (w.PaymentRequest) set(w.PaymentRequest.prototype, 'show', refuse);
      if (w.Notification) set(w.Notification, 'requestPermission', () => w.Promise.resolve('denied'));
      const leave = w.Document.prototype.exitFullscreen;
      const shown = own(w.Document.prototype, 'fullscreenElement').get;
      const away = () => {
        const doc = w.document;
        if (apply(shown, doc, [])) apply(leave, doc, []);
      };
      apply(listen, w, ['fullscreenchange', away, true]);
      apply(listen, w, ['webkitfullscreenchange', away, true]);
      const open = w.open;
      set(w, 'open', function () { return guard(apply(open, this, arguments)); });
      const fields = [
        [w.HTMLIFrameElement, 'contentWindow'], [w.HTMLIFrameElement, 'contentDocument'],
        [w.HTMLFrameElement, 'contentWindow'], [w.HTMLFrameElement, 'contentDocument'],
        [w.HTMLObjectElement, 'contentWindow'], [w.HTMLObjectElement, 'contentDocument'],
      ];
      for (let index = 0; index < fields.length; index += 1) {
        const type = fields[index][0];
        const key = fields[index][1];
        const field = own(type.prototype, key);
        define(type.prototype, key, {
          configurable: true,
          enumerable: field.enumerable,
          get() {
            const value = apply(field.get, this, []);
            guard(key === 'contentWindow' ? value : value && value.defaultView);
            return value;
          },
        });
      }
      for (let index = 0; index < w.frames.length; index += 1) guard(w.frames[index]);
    } catch {}
    return w;
  };
  guard(window);
})();"#;

/// History as the server gets it: each entry's id, address and title only (the browser also names
/// what was typed), and an entry that is no website, or was made while the person signed in, keeps
/// its place without address or title.
fn hide_off_web_entries(history: &mut Value, local: bool, hidden_through: u64) {
    for entry in history["entries"].as_array_mut().into_iter().flatten() {
        let url = entry["url"].as_str().unwrap_or("").to_owned();
        let signing = entry["id"].as_u64().is_some_and(|id| id <= hidden_through);
        *entry = if web_address(&url, local) && !signing {
            json!({ "id": entry["id"], "url": url, "title": entry["title"] })
        } else {
            json!({ "id": entry["id"], "url": "", "title": "" })
        };
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

/// The variables a browser on the desktop needs.
const BROWSER_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TMPDIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
];

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
    // Only what a desktop browser needs: no variable of this app's environment, such as
    // CHROMIUM_FLAGS or LD_PRELOAD, adds flags or code to it.
    command
        .env_clear()
        .envs(std::env::vars_os().filter(|(name, _)| {
            let name = name.to_string_lossy();
            BROWSER_ENV.contains(&name.as_ref()) || name.starts_with("LC_")
        }));
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
        let args = arguments(Path::new("/data/browser-profiles/abc"), false, 4242);
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
        assert!(arguments(Path::new("/p"), true, 1).contains(&"--headless=new".to_owned()));
        assert!(args.contains(&"--proxy-server=http://127.0.0.1:4242".to_owned()));
        assert!(args.contains(&"--proxy-bypass-list=<-loopback>".to_owned()));
    }

    #[test]
    fn it_passes_on_only_allowed_commands_and_parameters() {
        let ok = allowed(
            &json!({ "method": "Input.insertText", "params": { "text": "hi" } }),
            false,
        );
        assert_eq!(
            ok.unwrap(),
            ("Input.insertText".to_owned(), json!({ "text": "hi" }))
        );
        assert_eq!(
            allowed(&json!({ "method": "Page.enable" }), false)
                .unwrap()
                .1,
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
            json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "rawKeyDown", "key": "v", "modifiers": 2.0 } }),
            json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "rawKeyDown", "key": "v", "modifiers": -1 } }),
            json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "keyDown", "windowsVirtualKeyCode": 86.0, "modifiers": 4 } }),
            json!({ "method": "Input.dispatchMouseEvent", "params": { "type": "mousePressed", "x": 1, "y": 1, "button": "middle" } }),
            json!({ "method": "Input.dispatchMouseEvent", "params": { "type": "mouseMoved", "x": 1, "y": 1, "buttons": 4 } }),
            json!({ "method": "Page.bringToFront" }),
            json!({ "method": "Page.captureScreenshot", "params": { "captureBeyondViewport": true } }),
            json!({ "method": "Page.captureScreenshot", "params": { "clip": { "x": 0, "y": 0, "width": 99999, "height": 99999, "scale": 9 } } }),
        ] {
            assert!(allowed(&refused, false).is_err(), "passed: {refused}");
        }
        for url in [
            "https://example.test/a?b",
            "http://93.184.215.14/",
            "about:blank",
        ] {
            let navigate = json!({ "method": "Page.navigate", "params": { "url": url } });
            assert!(allowed(&navigate, false).is_ok(), "{url}");
        }
        let typed = json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "keyDown", "key": "v", "modifiers": 8 } });
        assert!(allowed(&typed, false).is_ok(), "Shift+V is a capital V");
    }

    #[test]
    fn it_opens_no_page_on_this_computer_or_its_network() {
        for url in [
            "http://127.0.0.1:8080/",
            "http://localhost:3000/",
            "http://app.localhost/",
            "http://printer.local/",
            "http://router.home.arpa/",
            "http://router/",
            "http://fritz.box/",
            "http://nas.lan/",
            "http://198.18.0.1/",
            "http://[64:ff9b::a00:1]/",
            "http://db.internal/",
            "http://10.0.0.1/",
            "http://172.16.5.4/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://[fd00::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://2130706433/",
            "http://0x7f.1/",
            "file:///etc/hosts",
            "chrome://settings/passwords",
        ] {
            assert!(!web_address(url, false), "{url}");
            let navigate = json!({ "method": "Page.navigate", "params": { "url": url } });
            assert!(allowed(&navigate, false).is_err(), "{url}");
        }
        assert!(
            web_address("http://127.0.0.1:8080/", true),
            "tests may open their own page"
        );
        assert!(!web_address("file:///etc/hosts", true));
        assert!(web_address("https://[2606:4700::1111]/", false));
    }

    #[test]
    fn keys_reach_the_page_s_text_and_never_the_browser_or_the_clipboard() {
        let key = |key: &str, code: &str, vk: u64, modifiers: u64| {
            allowed(
                &json!({ "method": "Input.dispatchKeyEvent", "params": {
                    "type": "rawKeyDown", "key": key, "code": code,
                    "windowsVirtualKeyCode": vk, "modifiers": modifiers } }),
                false,
            )
        };
        for (name, code, vk, modifiers) in [
            ("o", "KeyO", 79, 2),
            ("s", "KeyS", 83, 2),
            ("p", "KeyP", 80, 2),
            ("h", "KeyH", 72, 2),
            ("t", "KeyT", 84, 2),
            ("w", "KeyW", 87, 2),
            ("l", "KeyL", 76, 4),
            ("c", "KeyC", 67, 2),
            ("x", "KeyX", 88, 4),
            ("v", "KeyV", 86, 2),
            ("Delete", "Delete", 46, 2 | 8),
            ("ArrowLeft", "ArrowLeft", 37, 1),
            ("ArrowLeft", "ArrowLeft", 37, 4),
            ("[", "BracketLeft", 219, 4),
            ("F12", "F12", 123, 0),
            ("F5", "F5", 116, 0),
            ("BrowserBack", "BrowserBack", 166, 0),
            ("Insert", "Insert", 45, 8),
            ("Delete", "Delete", 46, 8),
            ("Insert", "Insert", 45, 2),
            ("Copy", "Copy", 0, 0),
            ("Cut", "Cut", 0, 0),
            ("Paste", "Paste", 0, 0),
            ("x", "Paste", 88, 0),
            ("a", "KeyO", 65, 2),
        ] {
            assert!(
                key(name, code, vk, modifiers).is_err(),
                "passed: {name} {modifiers}"
            );
        }
        for (name, code, vk, modifiers) in [
            ("a", "KeyA", 65, 2),
            ("a", "KeyA", 65, 4),
            ("z", "KeyZ", 90, 2),
            ("Backspace", "Backspace", 8, 2),
            ("ArrowRight", "ArrowRight", 39, 2 | 8),
            ("End", "End", 35, 2),
            ("A", "KeyA", 65, 8),
            ("Enter", "Enter", 13, 0),
            ("Tab", "Tab", 9, 8),
            ("Escape", "Escape", 27, 0),
        ] {
            assert!(
                key(name, code, vk, modifiers).is_ok(),
                "refused: {name} {modifiers}"
            );
        }
        let bare = json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "keyDown", "modifiers": 2 } });
        assert!(allowed(&bare, false).is_err(), "Ctrl with no key named");
        let with_text = json!({ "method": "Input.dispatchKeyEvent", "params": {
            "type": "keyDown", "key": "a", "code": "KeyA", "modifiers": 4, "text": "a",
            "unmodifiedText": "a", "nativeVirtualKeyCode": 0 } });
        let (_, sent) = allowed(&with_text, false).unwrap();
        assert_eq!(
            sent,
            json!({ "type": "keyDown", "key": "a", "code": "KeyA", "modifiers": 4 })
        );
        let plain = json!({ "method": "Input.dispatchKeyEvent", "params": { "type": "keyDown", "key": "a", "text": "a" } });
        assert_eq!(
            allowed(&plain, false).unwrap().1["text"],
            "a",
            "text stays without modifiers"
        );
        for button in [
            json!({ "button": "back" }),
            json!({ "button": "forward" }),
            json!({ "buttons": 8 }),
            json!({ "buttons": 16 }),
        ] {
            let mut params = json!({ "type": "mousePressed", "x": 1, "y": 1 });
            params
                .as_object_mut()
                .unwrap()
                .extend(button.as_object().unwrap().clone());
            let click = json!({ "method": "Input.dispatchMouseEvent", "params": params });
            assert!(allowed(&click, false).is_err(), "passed: {click}");
        }
        for vendor in ["Chrome", "Edge", "Brave", "Chromium"] {
            assert!(!NO_BROWSER.contains(vendor), "the refusal names {vendor}");
        }
    }

    #[test]
    fn history_made_while_signing_in_keeps_no_address() {
        let mut history = json!({ "currentIndex": 1, "entries": [
            { "id": 4, "url": "https://x.test/callback?code=SECRET", "title": "Signed in" },
            { "id": 7, "url": "https://x.test/home", "title": "Home" },
        ] });
        hide_off_web_entries(&mut history, false, 4);
        assert_eq!(
            history["entries"][0],
            json!({ "id": 4, "url": "", "title": "" })
        );
        assert_eq!(history["entries"][1]["url"], "https://x.test/home");
    }

    #[test]
    fn a_sign_in_opens_only_a_site_s_home() {
        assert_eq!(sign_in_site(" X.com/ ", false).as_deref(), Some("x.com"));
        for site in [
            "https://x.com",
            "x.com/login",
            "x.com?next=/",
            "localhost",
            "router",
            "10.0.0.1",
            ".x.com",
            "",
            "x.com:8080",
        ] {
            assert!(sign_in_site(site, false).is_none(), "{site}");
        }
        assert_eq!(
            sign_in_site("127.0.0.1:8080", true).as_deref(),
            Some("127.0.0.1:8080")
        );
    }

    #[test]
    fn history_of_pages_that_are_not_websites_keeps_no_address() {
        let mut history = json!({ "currentIndex": 1, "entries": [
            { "id": 1, "url": "file:///home/ada/notes.txt", "title": "notes.txt" },
            { "id": 2, "url": "https://example.test/", "title": "Example", "userTypedURL": "file:///x" },
            { "id": 3, "url": "chrome://password-manager/passwords", "title": "Passwords" },
        ] });
        hide_off_web_entries(&mut history, false, 0);
        assert_eq!(
            history["entries"][0],
            json!({ "id": 1, "url": "", "title": "" })
        );
        assert_eq!(
            history["entries"][1],
            json!({ "id": 2, "url": "https://example.test/", "title": "Example" })
        );
        assert_eq!(history["entries"][2]["title"], "");
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
    async fn deleting_a_bot_ends_its_sign_in_and_stopping_it_does_not() {
        let dir = std::env::temp_dir().join(format!("dozo-browser-delete-{}", std::process::id()));
        let browsers = Browsers::with(dir.clone(), None, true);
        std::fs::create_dir_all(dir.join("k")).unwrap();
        browsers.mark_signing("k", Some("x.com"));
        browsers.close("k", false).await;
        assert_eq!(browsers.signing_site("k").as_deref(), Some("x.com"));
        assert!(dir.join("k").exists());
        browsers.close("k", true).await;
        assert!(browsers.signing_site("k").is_none());
        assert!(!dir.join("k").exists(), "the deleted bot's profile stayed");
        let _ = std::fs::remove_dir_all(&dir);
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
