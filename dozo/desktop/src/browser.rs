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

/// Whether this app tells servers it has a browser for bots. Off until the sign-in pause comes
/// (the person signs in while the app passes on nothing): until then no server offers the bot's
/// browser, and this module is reached only by its tests.
pub const DECLARED: bool = false;

pub const NO_BROWSER: &str = "No Chrome, Edge, Brave or Chromium is installed on this computer.";
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
    // A middle click pastes what the person last selected anywhere (Linux).
    let middle = given.get("button").and_then(Value::as_str) == Some("middle")
        || given.get("buttons").and_then(Value::as_u64).unwrap_or(0) & 4 != 0;
    if method == "Input.dispatchMouseEvent" && middle {
        return Err("Not allowed in the bot's browser: middle click".to_owned());
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
    // The address parser has already written any form of an IP address the usual way.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    local
        || match bare.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V4(ip)) => public_v4(ip),
            Ok(std::net::IpAddr::V6(ip)) => match ip.to_ipv4_mapped() {
                Some(ip) => public_v4(ip),
                None => {
                    let first = ip.segments()[0];
                    !(ip.is_loopback()
                        || ip.is_unspecified()
                        || first & 0xfe00 == 0xfc00
                        || first & 0xffc0 == 0xfe80)
                }
            },
            Err(_) => {
                let name = bare.trim_end_matches('.').to_ascii_lowercase();
                !(name == "localhost"
                    || [".localhost", ".local", ".internal", ".home.arpa"]
                        .iter()
                        .any(|suffix| name.ends_with(suffix)))
            }
        }
}

fn public_v4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || a == 0
        || (a == 100 && (64..128).contains(&b)))
}

/// A key press that reaches more than the page's text: the clipboard (Ctrl or Cmd with V or C,
/// Shift with Insert, which copy or paste), or the browser's own shortcuts (Alt with anything, Ctrl
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
    if browser_key || modifiers & 1 != 0 {
        return true;
    }
    if modifiers & 8 != 0 && (names.iter().any(|name| name == "insert") || code == Some(45)) {
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
    #[cfg(unix)]
    child: Mutex<Option<tokio::process::Child>>,
}

impl Running {
    /// The bot's page, attached once: its first tab showing a website or a blank page, or a new one
    /// when the person closed those (a tab of the browser's own pages or this computer's files is
    /// never taken).
    async fn page(&self, local: bool) -> Result<String, String> {
        let _attaching = self.attach.lock().await;
        if let Some(session) = self.pipe.session.lock().unwrap().clone() {
            return Ok(session);
        }
        let mut target = None;
        for _ in 0..50 {
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

    /// Ends the browser; the profile is free once this returns.
    async fn end_and_wait(&self) {
        self.pipe.close();
        #[cfg(unix)]
        {
            let child = self.child.lock().unwrap().take();
            if let Some(mut child) = child {
                crate::stack_os::kill(&mut child);
                let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
            }
        }
    }

    fn end(&self) {
        self.pipe.close();
        #[cfg(unix)]
        if let Some(mut child) = self.child.lock().unwrap().take() {
            crate::stack_os::kill(&mut child);
        }
    }
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
    open: Mutex<HashMap<String, Arc<Running>>>,
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
            open: Mutex::default(),
            starting: tokio::sync::Mutex::default(),
            generation: AtomicU64::new(0),
        }
    }

    /// Lets tests open the page they serve on loopback.
    #[cfg(test)]
    pub fn with_local_pages(mut self) -> Self {
        self.local = true;
        self
    }

    pub fn available(&self) -> bool {
        self.program.is_some()
    }

    /// Runs one allowed command on the bot's page, starting its browser when none runs, and
    /// answers with the result and the page events since the last answer. Only going to a website
    /// works while the page shows anything else.
    pub async fn handle(&self, key: &str, command: &Value) -> Result<Value, String> {
        let (method, params) = allowed(command, self.local)?;
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
            if !web_address(url, self.local) {
                return Err(NOT_WEB.to_owned());
            }
        }
        let result = running.pipe.call(&method, params, Some(&session)).await;
        if !running.pipe.open.load(Ordering::SeqCst) {
            self.forget(key, &running);
        }
        let mut result = result?;
        if method == "Page.getNavigationHistory" {
            hide_off_web_entries(&mut result, self.local);
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
        let running = {
            let mut open = self.open.lock().unwrap();
            // A browser starting meanwhile is ended rather than kept.
            self.generation.fetch_add(1, Ordering::SeqCst);
            open.remove(key)
        };
        if let Some(running) = running {
            running.end_and_wait().await;
        }
        if forget_profile {
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
        let (child, pipe) = launch(program, &arguments(&profile, self.headless))
            .await
            .map_err(|_| "The bot's browser could not start".to_owned())?;
        if let Some(pid) = child.id() {
            let _ = std::fs::write(&pid_file, pid.to_string());
        }
        let running = Running {
            pipe,
            attach: tokio::sync::Mutex::default(),
            target: Mutex::default(),
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
    Ok(())
}

/// A click the server sends counts as the person's gesture, so a page could use it to write the
/// clipboard or take the whole screen. The permission above stops the clipboard API; this stops the
/// older copy and cut commands and full screen, in every frame. A page that opens a window still
/// can (sign-ins need it): it opens as a tab the bot cannot reach.
const GUARD: &str = "(() => {
  const exec = Document.prototype.execCommand;
  Document.prototype.execCommand = function (command, ...rest) {
    return ['copy', 'cut', 'paste'].includes(String(command).toLowerCase())
      ? false
      : exec.call(this, command, ...rest);
  };
  const refuse = () => Promise.reject(new DOMException('Not allowed here', 'NotAllowedError'));
  Element.prototype.requestFullscreen = refuse;
  if (Element.prototype.webkitRequestFullscreen) Element.prototype.webkitRequestFullscreen = () => {};
})();";

/// History as the server gets it: each entry's id, address and title only (the browser also names
/// what was typed), and an entry that is no website keeps its place without address or title.
fn hide_off_web_entries(history: &mut Value, local: bool) {
    for entry in history["entries"].as_array_mut().into_iter().flatten() {
        let url = entry["url"].as_str().unwrap_or("").to_owned();
        *entry = if web_address(&url, local) {
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
    }

    #[test]
    fn history_of_pages_that_are_not_websites_keeps_no_address() {
        let mut history = json!({ "currentIndex": 1, "entries": [
            { "id": 1, "url": "file:///home/ada/notes.txt", "title": "notes.txt" },
            { "id": 2, "url": "https://example.test/", "title": "Example", "userTypedURL": "file:///x" },
            { "id": 3, "url": "chrome://password-manager/passwords", "title": "Passwords" },
        ] });
        hide_off_web_entries(&mut history, false);
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
