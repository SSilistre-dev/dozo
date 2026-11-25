//! The one bridge a page of the chosen server has into the app: the "Desktop app" section of the
//! web app's Settings (`apps/web/src/components/dozo-desktop-app.tsx`) reads the app's switches
//! and changes the harmless ones. It is the only place a page loaded from a server can call the
//! app, so everything it may do is in [`CHANNELS`] and nothing else is granted to such a page.
//!
//! | Command            | Window | Origin                        | Input                     | Refused   |
//! |--------------------|--------|-------------------------------|---------------------------|-----------|
//! | `desktop_settings` | main   | the chosen server, exactly    | `seen`: what it shows now | `null`    |
//! | `desktop_set`      | main   | the chosen server, exactly    | a [`Key`] name, a boolean | `null`    |
//! | `desktop_open`     | main   | the chosen server, exactly    | `changeServer`, `appSettings` | `null` |
//!
//! - Every call shares one [`Budget`]; a call over it is refused.
//! - A refused call is answered as one that did nothing: a write always answers `null`, so a page
//!   cannot tell refused from done, and the switches are only ever sent to the chosen server.
//! - Input is read as plain JSON: a wrong type or a missing field is refused like the rest, never a
//!   Tauri error that says what was expected.
//! - What a page may change at once ([`asks`]): Push to Talk, on and off (its keys stay fixed, and
//!   turning it on is held to once in [`TALK_GAP`]), and the safe way of three switches: Open at
//!   Login, Keep Running in Background and Let Bots Use This Computer turned off. Everything else
//!   it may only ask for: turning those three on, and the password manager either way (off
//!   removes every linked login). The app asks in a window of its own (`ui/confirm.html`, [`ask`]):
//!   one question at a time, none within [`QUESTION_GAP`] of the last, none for a switch the person
//!   refused in the last [`ASK_AGAIN_AFTER`], and an answer counts only while the server that
//!   asked is still the chosen one. Allowed, it does what the menu item does, which for the
//!   computer and for turning the password manager on asks the menu's own question too. The page
//!   never gives an address, a path, a shortcut or any text.
//!
//! The server is chosen while the app runs, and a capability file is fixed when the app is built,
//! so no file can name it: [`admit`] grants these three commands to one origin, the chosen
//! server's, once its page starts loading in the window. Tauri can add a capability but never take
//! one back, so each command also checks the caller itself ([`caller`]): the window's own page,
//! on the origin that is chosen now. An earlier server keeps its grant until the app ends and is
//! refused here. A frame inside the page never has the bridge: Tauri gives its call key, and the
//! app its bridge (`SHELL_MARK` in main.rs), to the window's own page only.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::ipc::CapabilityBuilder;
use tauri::{
    AppHandle, Manager, Url, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::{oneshot, watch};

use crate::words::text;

/// The app's window, the only one whose page may use the bridge.
const WINDOW: &str = "main";

/// Every command a server's page may call, with the permission that grants it. Nothing else is
/// ever granted to a remote origin.
pub const CHANNELS: [(&str, &str); 3] = [
    ("desktop_settings", "allow-desktop-settings"),
    ("desktop_set", "allow-desktop-set"),
    ("desktop_open", "allow-desktop-open"),
];

/// A switch the section shows, by the name the page uses.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Key {
    OpenAtLogin,
    KeepRunning,
    PushToTalk,
    ThisComputer,
    PasswordManager,
}

impl Key {
    const ALL: [Key; 5] = [
        Key::OpenAtLogin,
        Key::KeepRunning,
        Key::PushToTalk,
        Key::ThisComputer,
        Key::PasswordManager,
    ];

    fn name(self) -> &'static str {
        match self {
            Key::OpenAtLogin => "openAtLogin",
            Key::KeepRunning => "keepRunning",
            Key::PushToTalk => "pushToTalk",
            Key::ThisComputer => "thisComputer",
            Key::PasswordManager => "passwordManager",
        }
    }

    /// The menu item it is: what the menu shows, and what picking it does (`crate::run`).
    fn menu_id(self) -> &'static str {
        match self {
            Key::OpenAtLogin => crate::OPEN_AT_LOGIN_ID,
            Key::KeepRunning => crate::KEEP_RUNNING_ID,
            Key::PushToTalk => crate::talk::MENU_ID,
            Key::ThisComputer => crate::device::MENU_ID,
            Key::PasswordManager => crate::passwords_ui::MENU_ID,
        }
    }

    fn parse(value: Option<&Value>) -> Option<Key> {
        let name = value?.as_str()?;
        Key::ALL.into_iter().find(|key| key.name() == name)
    }
}

/// What a request to set a switch comes to.
#[derive(Debug, PartialEq)]
enum Plan {
    Nothing,
    /// As picking the menu item.
    Flip,
    /// Only once the person allows it here.
    Ask,
}

/// Whether a page only asks to set `key` to `wanted`, the person answering. Push to Talk sends
/// nothing by itself: the page hears the keys only while they are held (`talk::pressed`). Open at
/// Login and Keep Running in Background on would keep a page running out of sight, and its
/// origin is let use the microphone (`alerts.rs`). Let Bots Use This Computer on lets the server
/// run programs here. The password manager on lets bots fill logins, and off removes every link.
fn asks(key: Key, wanted: bool) -> bool {
    match key {
        Key::PushToTalk => false,
        Key::PasswordManager => true,
        Key::OpenAtLogin | Key::KeepRunning | Key::ThisComputer => wanted,
    }
}

/// `now` is the switch's state, none while the menu does not offer it.
fn plan(key: Key, now: Option<bool>, wanted: bool) -> Plan {
    match now {
        Some(now) if now == wanted => Plan::Nothing,
        Some(_) if asks(key, wanted) => Plan::Ask,
        Some(_) => Plan::Flip,
        None => Plan::Nothing,
    }
}

/// True, and noted, unless the last time was less than `gap` ago.
fn once_per(last: &mut Option<Instant>, now: Instant, gap: Duration) -> bool {
    if last.is_some_and(|at| now.saturating_duration_since(at) < gap) {
        return false;
    }
    *last = Some(now);
    true
}

/// How often a page may open something (Change Server, the Settings window): each brings a window
/// forward and takes the focus, as `dozo-app://settings` did at most once a second.
const OPEN_GAP: Duration = Duration::from_secs(1);

/// How often a page may turn Push to Talk on: a shortcut another program holds is said in a
/// message each time, which a page must not repeat.
const TALK_GAP: Duration = Duration::from_secs(30);

/// Whether a call comes from the window's own page, on the chosen server's origin.
fn caller(window: &str, webview: &str, page: Option<&Url>, server: Option<&Url>) -> bool {
    window == WINDOW && webview == WINDOW && crate::prefs::from_server(page, server)
}

/// How many calls the bridge answers: up to [`Budget::BURST`] at once, refilled at
/// [`Budget::PER_SECOND`].
struct Budget {
    tokens: f64,
    at: Option<Instant>,
}

impl Budget {
    const BURST: f64 = 10.0;
    const PER_SECOND: f64 = 5.0;

    const fn new() -> Self {
        Budget {
            tokens: Budget::BURST,
            at: None,
        }
    }

    fn take(&mut self, now: Instant) -> bool {
        if let Some(at) = self.at {
            let refill = now.saturating_duration_since(at).as_secs_f64() * Budget::PER_SECOND;
            self.tokens = (self.tokens + refill).min(Budget::BURST);
        }
        self.at = Some(now);
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

/// The `remote` address pattern for the chosen server's origin, none for anything else.
fn pattern(server: &Url) -> Option<String> {
    if !matches!(server.scheme(), "http" | "https") {
        return None;
    }
    // A host name or address never holds what the pattern reads as syntax but these, which an
    // IPv6 address has: written as they are.
    let host = server.host_str()?;
    if host.contains(|c: char| !(c.is_ascii_alphanumeric() || ".-[]:".contains(c))) {
        return None;
    }
    let host = host.replace(':', "\\:");
    let port = server
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!("{}://{host}{port}/*", server.scheme()))
}

fn capability(pattern: &str, number: usize) -> CapabilityBuilder {
    CHANNELS.iter().fold(
        CapabilityBuilder::new(format!("server-page-{number}"))
            .remote(pattern.to_owned())
            .local(false)
            .window(WINDOW),
        |capability, (_, permission)| capability.permission(*permission),
    )
}

/// The window's page started loading on the chosen server: its origin may call [`CHANNELS`] from
/// now on, as far as Tauri is concerned (each command checks again). Once per origin.
fn admit(app: &AppHandle, server: &Url) {
    static ADMITTED: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let Some(pattern) = pattern(server) else {
        return;
    };
    let mut admitted = ADMITTED.lock().unwrap();
    if admitted.contains(&pattern) {
        return;
    }
    match app.add_capability(capability(&pattern, admitted.len())) {
        Ok(()) => admitted.push(pattern),
        Err(error) => eprintln!("dozo: the page cannot reach the app's settings: {error}"),
    }
}

/// The caller is the chosen server's page in the app's window, and within the budget.
fn allowed(app: &AppHandle, webview: &Webview) -> bool {
    static BUDGET: Mutex<Budget> = Mutex::new(Budget::new());
    from_page(app, webview) && BUDGET.lock().unwrap().take(Instant::now())
}

fn from_page(app: &AppHandle, webview: &Webview) -> bool {
    caller(
        webview.window().label(),
        webview.label(),
        webview.url().ok().as_ref(),
        crate::chosen(app).as_ref(),
    )
}

/// A switch's state, none while the menu does not offer it.
fn switch_now(app: &AppHandle, key: Key) -> Option<bool> {
    let item = crate::switch_item(app, key.menu_id())?;
    if !item.is_enabled().ok()? {
        return None;
    }
    item.is_checked().ok()
}

fn state(app: &AppHandle) -> Value {
    let switches: Vec<Value> = Key::ALL
        .iter()
        .filter_map(|key| switch_now(app, *key).map(|on| json!({ "key": key.name(), "on": on })))
        .collect();
    json!({
        "version": app.package_info().version.to_string(),
        "talkKeys": crate::talk::KEYS,
        "switches": switches,
    })
}

/// The switches and the version, once they differ from `seen` (what the section shows now): the
/// page asks again after each answer, and nothing is asked on a timer.
/// How many reads may wait at once. One is enough: a new read ends the one before it.
const MAX_WAITING: usize = 4;

/// The reads that wait for a change. The window has one page and the section keeps one read
/// waiting, so a new read ends every earlier one (a section shown again, or a page that never
/// cancels its own), and so does a new page starting to load: none is left behind to fill
/// [`MAX_WAITING`].
struct Reads {
    latest: watch::Sender<u64>,
    waiting: AtomicUsize,
}

/// One read: its place among those waiting, and the word that a later one took over.
struct Read<'a> {
    _waiting: Waiting<'a>,
    superseded: watch::Receiver<u64>,
}

impl Reads {
    fn new() -> Self {
        Reads {
            latest: watch::Sender::new(0),
            waiting: AtomicUsize::new(0),
        }
    }

    /// Ends every read waiting now.
    fn supersede(&self) {
        self.latest.send_modify(|count| *count += 1);
    }

    /// A new read, ending the earlier ones; none while [`MAX_WAITING`] still wait (only calls
    /// made at the same moment, before the earlier ones have ended).
    fn start(&self) -> Option<Read<'_>> {
        self.supersede();
        let mut superseded = self.latest.subscribe();
        superseded.borrow_and_update();
        Waiting::take(&self.waiting, MAX_WAITING).map(|waiting| Read {
            _waiting: waiting,
            superseded,
        })
    }
}

static READS: LazyLock<Reads> = LazyLock::new(Reads::new);

/// A place among the reads that wait, given back when the read ends however it ends.
struct Waiting<'a>(&'a AtomicUsize);

impl<'a> Waiting<'a> {
    fn take(count: &'a AtomicUsize, max: usize) -> Option<Self> {
        // Taken first and given back when there was no room: never more than `max` at once.
        let waiting = Waiting(count);
        (count.fetch_add(1, Ordering::SeqCst) < max).then_some(waiting)
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The window's page started loading (any page): reads left waiting end, and when it is the chosen
/// server's, its origin is admitted ([`admit`]).
pub fn page_loading(app: &AppHandle, page: &Url) {
    READS.supersede();
    if crate::chosen(app).is_some_and(|server| server.origin() == page.origin()) {
        admit(app, page);
    }
}

#[tauri::command]
pub async fn desktop_settings(app: AppHandle, webview: Webview, seen: Option<Value>) -> Value {
    if !allowed(&app, &webview) {
        return Value::Null;
    }
    let Some(mut read) = READS.start() else {
        return Value::Null;
    };
    let mut changes = crate::prefs::watch(&app);
    loop {
        changes.borrow_and_update();
        let now = state(&app);
        if seen.as_ref() != Some(&now) {
            // Asked again: the page may have gone elsewhere while this waited.
            return if from_page(&app, &webview) {
                now
            } else {
                Value::Null
            };
        }
        tokio::select! {
            changed = changes.changed() => if changed.is_err() { return Value::Null },
            _ = read.superseded.changed() => return Value::Null,
        }
    }
}

/// What a call to set a switch comes to: nothing for a refused caller or input that is not a
/// [`Key`] and a boolean.
fn request(
    allowed: bool,
    key: Option<&Value>,
    on: Option<&Value>,
    now: impl Fn(Key) -> Option<bool>,
) -> (Plan, Option<Key>) {
    let (true, Some(key), Some(Value::Bool(wanted))) = (allowed, Key::parse(key), on) else {
        return (Plan::Nothing, None);
    };
    (plan(key, now(key), *wanted), Some(key))
}

/// Sets a switch, as far as the page may (see the file's notes). Answers nothing, whatever
/// happened: the type says so.
#[tauri::command]
pub async fn desktop_set(app: AppHandle, webview: Webview, key: Option<Value>, on: Option<Value>) {
    let allowed = allowed(&app, &webview);
    match request(allowed, key.as_ref(), on.as_ref(), |key| {
        switch_now(&app, key)
    }) {
        (Plan::Flip, Some(key)) => {
            static TALK_ON: Mutex<Option<Instant>> = Mutex::new(None);
            let wanted = on.as_ref().and_then(Value::as_bool) == Some(true);
            if key == Key::PushToTalk
                && wanted
                && !once_per(&mut TALK_ON.lock().unwrap(), Instant::now(), TALK_GAP)
            {
                return;
            }
            flip(&app, key, wanted).await;
        }
        (Plan::Ask, Some(key)) => {
            let wanted = on.as_ref().and_then(Value::as_bool) == Some(true);
            ask(&app, key, wanted);
        }
        _ => {}
    }
}

/// Opens what only the app may show: the screen to choose another server, or the app's own
/// Settings window (the logins of the password manager). Answers nothing, whatever happened.
#[tauri::command]
pub async fn desktop_open(app: AppHandle, webview: Webview, what: Option<Value>) {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let id = opens(allowed(&app, &webview), what.as_ref());
    if let Some(id) = id.filter(|_| once_per(&mut LAST.lock().unwrap(), Instant::now(), OPEN_GAP)) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || crate::run(&handle, id));
    }
}

/// The menu item a call to open something picks, if any.
fn opens(allowed: bool, what: Option<&Value>) -> Option<&'static str> {
    match what?.as_str()? {
        "changeServer" if allowed => Some("change-server"),
        "appSettings" if allowed => Some(crate::prefs::MENU_ITEM_ID),
        _ => None,
    }
}

/// What picking the switch's menu item does, when it is not `wanted` already; waits for it to
/// start, so the page's next read sees it.
async fn flip(app: &AppHandle, key: Key, wanted: bool) {
    let (done, started) = oneshot::channel();
    let handle = app.clone();
    let asked = app.run_on_main_thread(move || {
        let app = &handle;
        if let Some(item) = crate::switch_item(app, key.menu_id())
            && item.is_checked().is_ok_and(|on| on != wanted)
        {
            let _ = item.set_checked(wanted);
            crate::run(app, key.menu_id());
        }
        let _ = done.send(());
    });
    if asked.is_ok() {
        let _ = started.await;
    }
}

/// How long the question waits for an answer before it counts as Cancel.
const QUESTION_LIMIT: Duration = Duration::from_secs(60);
/// The least time between two questions, whatever they ask.
const QUESTION_GAP: Duration = Duration::from_secs(10);
/// A switch the person refused (Cancel, no answer, or the server changed) is not asked about
/// again for this long; a request meanwhile is dropped.
const ASK_AGAIN_AFTER: Duration = Duration::from_secs(5 * 60);
const QUESTION_WINDOW: &str = "confirm";

/// The question on screen.
struct Question {
    id: u64,
    key: Key,
    wanted: bool,
    /// The chosen server when it was asked: the answer counts only while it still is.
    origin: Url,
    words: String,
}

/// The question on screen, if any, and what limits the next one.
struct Questions {
    open: Option<Question>,
    last: Option<Instant>,
    refused: Vec<(Key, Instant)>,
    count: u64,
}

impl Questions {
    const fn new() -> Self {
        Questions {
            open: None,
            last: None,
            refused: Vec::new(),
            count: 0,
        }
    }

    /// Puts a question up; none while one is open, within [`QUESTION_GAP`] of the last, or for a
    /// switch refused within [`ASK_AGAIN_AFTER`].
    fn put(
        &mut self,
        key: Key,
        wanted: bool,
        origin: Url,
        words: String,
        now: Instant,
    ) -> Option<u64> {
        let recently = |at: Instant, gap: Duration| now.saturating_duration_since(at) < gap;
        if self.open.is_some()
            || self.last.is_some_and(|at| recently(at, QUESTION_GAP))
            || self
                .refused
                .iter()
                .any(|(refused, at)| *refused == key && recently(*at, ASK_AGAIN_AFTER))
        {
            return None;
        }
        let id = self.count;
        self.count += 1;
        self.last = Some(now);
        self.open = Some(Question {
            id,
            key,
            wanted,
            origin,
            words,
        });
        Some(id)
    }

    /// Ends the question on screen (only question `id`, when given) with the person's answer.
    /// Answers the question and whether the answer is to be carried out: an Allow while the
    /// server that asked is still `chosen`. Anything else counts as refused.
    fn end(
        &mut self,
        id: Option<u64>,
        allow: bool,
        chosen: Option<&Url>,
        now: Instant,
    ) -> Option<(Question, bool)> {
        if id.is_some_and(|id| self.open.as_ref().is_none_or(|open| open.id != id)) {
            return None;
        }
        let open = self.open.take()?;
        let carried = allow && chosen.is_some_and(|chosen| chosen.origin() == open.origin.origin());
        if !carried {
            self.refused
                .retain(|(_, at)| now.saturating_duration_since(*at) < ASK_AGAIN_AFTER);
            self.refused.push((open.key, now));
        }
        Some((open, carried))
    }
}

static QUESTIONS: Mutex<Questions> = Mutex::new(Questions::new());

/// The page asked to set a switch it may not set itself: the app asks the person in its own window.
fn ask(app: &AppHandle, key: Key, wanted: bool) {
    let Some(origin) = crate::chosen(app) else {
        return;
    };
    let label = crate::switch_item(app, key.menu_id())
        .and_then(|item| item.text().ok())
        .unwrap_or_default();
    let words = if wanted {
        text("{host} asks to turn on “{label}”.")
    } else {
        text("{host} asks to turn off “{label}”.")
    };
    let words = words
        .replace("{host}", &host(&origin))
        .replace("{label}", &label);
    let asked = QUESTIONS
        .lock()
        .unwrap()
        .put(key, wanted, origin, words, Instant::now());
    let Some(id) = asked else {
        return;
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || show_question(&handle));
    // Unanswered in time: Cancel.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(QUESTION_LIMIT).await;
        answer(&handle, Some(id), false);
    });
}

/// The server as the question names it: its host, and its port when it has one.
fn host(server: &Url) -> String {
    let name = server.host_str().unwrap_or_default();
    server
        .port()
        .map_or_else(|| name.to_owned(), |port| format!("{name}:{port}"))
}

/// The person's answer to the question on screen (question `id` only, when given), or Cancel;
/// only the first one counts, and the window closes with it.
fn answer(app: &AppHandle, id: Option<u64>, allow: bool) {
    let chosen = crate::chosen(app);
    let ended = QUESTIONS
        .lock()
        .unwrap()
        .end(id, allow, chosen.as_ref(), Instant::now());
    let Some((open, carried)) = ended else {
        return;
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(QUESTION_WINDOW) {
            let _ = window.destroy();
        }
    });
    if carried {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { flip(&app, open.key, open.wanted).await });
    }
}

fn show_question(app: &AppHandle) {
    let built =
        WebviewWindowBuilder::new(app, QUESTION_WINDOW, WebviewUrl::App("confirm.html".into()))
            .title("Dozo")
            .inner_size(420.0, 180.0)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .always_on_top(true)
            .center()
            // Only its own page loads here.
            .on_navigation(crate::server::is_local)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build();
    match built {
        Ok(window) => {
            #[cfg(not(target_os = "macos"))]
            let _ = window.remove_menu();
            let app = app.clone();
            // Closing the window without answering is Cancel.
            window.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    answer(&app, None, false);
                }
            });
            let _ = window.set_focus();
        }
        Err(error) => {
            eprintln!("dozo: could not open the question: {error}");
            answer(app, None, false);
        }
    }
}

/// What the question's window shows. Every word comes from the app, in the system's language.
/// Only that window is answered, whatever the capability says.
#[tauri::command]
pub fn confirm_question(webview: Webview) -> Option<Value> {
    if webview.label() != QUESTION_WINDOW {
        return None;
    }
    let questions = QUESTIONS.lock().unwrap();
    questions.open.as_ref().map(|open| {
        json!({
            "lang": if crate::words::turkish() { "tr" } else { "en" },
            "question": open.words,
            "allow": text(if open.wanted { "Turn On" } else { "Turn Off" }),
            "cancel": text("Cancel"),
        })
    })
}

/// The person's answer in the question's window (`capabilities/confirm.json`); from any other
/// window it is nothing.
#[tauri::command]
pub fn confirm_answer(window: WebviewWindow, allow: Option<Value>) {
    if window.label() != QUESTION_WINDOW {
        return;
    }
    answer(window.app_handle(), None, allow == Some(Value::Bool(true)));
}

/// The app is quitting: an open question goes with it, as Cancel.
pub fn close(app: &AppHandle) {
    answer(app, None, false);
}

#[cfg(test)]
mod tests {
    use tauri::ipc::RuntimeCapability;
    use tauri::utils::acl::RemoteUrlPattern;
    use tauri::utils::acl::capability::CapabilityFile;

    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_window_s_own_page_on_the_chosen_server_may_call() {
        let server = url("https://dozo.example.com/");
        let page = |address: &str| caller("main", "main", Some(&url(address)), Some(&server));
        assert!(page("https://dozo.example.com/settings?section=general"));
        for other in [
            "https://evil.test/",
            "http://dozo.example.com/",
            "https://dozo.example.com:8443/",
            "https://dozo.example.com.evil.test/",
            "https://evil.test/dozo.example.com",
            "https://sub.dozo.example.com/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "about:blank",
            "data:text/html,x",
            "blob:https://dozo.example.com/0b0e",
        ] {
            assert!(!page(other), "{other}");
        }
        // Another window or web view, or no page or no server.
        let at = url("https://dozo.example.com/x");
        assert!(!caller("prefs", "prefs", Some(&at), Some(&server)));
        assert!(!caller("main", "frame", Some(&at), Some(&server)));
        assert!(!caller("confirm", "main", Some(&at), Some(&server)));
        assert!(!caller("main", "main", None, Some(&server)));
        assert!(!caller("main", "main", Some(&at), None));
        // A server on this computer is plain http.
        let local = url("http://127.0.0.1:4545/");
        assert!(caller(
            "main",
            "main",
            Some(&url("http://127.0.0.1:4545/x")),
            Some(&local)
        ));
        assert!(!caller(
            "main",
            "main",
            Some(&url("http://127.0.0.1:4546/x")),
            Some(&local)
        ));
    }

    #[test]
    fn a_server_left_behind_is_refused_though_its_grant_stays() {
        let old = url("https://old.example.com/");
        let new = url("https://new.example.com/");
        let page = url("https://old.example.com/settings");
        assert!(caller("main", "main", Some(&page), Some(&old)));
        assert!(!caller("main", "main", Some(&page), Some(&new)));
        // Tauri still lets the old origin through: the grant is never taken back.
        let grant: RemoteUrlPattern = pattern(&old).unwrap().parse().unwrap();
        assert!(grant.test(&page));
    }

    #[test]
    fn the_grant_names_the_chosen_origin_and_nothing_near_it() {
        for (server, inside, outside) in [
            (
                "https://dozo.example.com/",
                vec![
                    "https://dozo.example.com/",
                    "https://dozo.example.com/settings?section=general#x",
                ],
                vec![
                    "http://dozo.example.com/",
                    "https://dozo.example.com:8443/",
                    "https://dozo.example.com.evil.test/",
                    "https://sub.dozo.example.com/",
                    "https://evil.test/dozo.example.com/",
                    "https://dozoXexample.com/",
                ],
            ),
            (
                "https://dozo.example.com:8443/",
                vec!["https://dozo.example.com:8443/x"],
                vec![
                    "https://dozo.example.com/",
                    "https://dozo.example.com:8444/",
                ],
            ),
            (
                "http://127.0.0.1:4545/",
                vec!["http://127.0.0.1:4545/x"],
                vec![
                    "http://127.0.0.1:4546/",
                    "http://127.0.0.1/",
                    "https://127.0.0.1:4545/",
                    "http://127.0.0.10:4545/",
                ],
            ),
            (
                "http://localhost:6173/",
                vec!["http://localhost:6173/"],
                vec!["http://localhost.evil.test:6173/", "http://localhost:6174/"],
            ),
            (
                "http://[::1]:5173/",
                vec!["http://[::1]:5173/x"],
                vec![
                    "http://[::2]:5173/",
                    "http://127.0.0.1:5173/",
                    "http://[::1]:5174/",
                ],
            ),
        ] {
            let grant: RemoteUrlPattern = pattern(&url(server))
                .unwrap()
                .parse()
                .unwrap_or_else(|error| panic!("{server}: {error:?}"));
            for page in inside {
                assert!(grant.test(&url(page)), "{server} {page}");
            }
            for page in outside {
                assert!(!grant.test(&url(page)), "{server} {page}");
            }
        }
        for not_a_server in [
            "tauri://localhost/",
            "file:///etc/passwd",
            "data:text/html,x",
        ] {
            assert_eq!(pattern(&url(not_a_server)), None, "{not_a_server}");
        }
    }

    #[test]
    fn the_grant_is_the_bridge_s_three_commands_in_the_app_window_only() {
        let CapabilityFile::Capability(granted) =
            capability("https://dozo.example.com/*", 0).build()
        else {
            panic!("one capability");
        };
        assert!(!granted.local);
        assert_eq!(granted.windows, ["main"]);
        assert!(granted.webviews.is_empty());
        let remote = granted.remote.expect("a remote origin");
        assert_eq!(remote.urls, ["https://dozo.example.com/*"]);
        let permissions: Vec<String> = granted
            .permissions
            .iter()
            .map(|permission| permission.identifier().get().to_owned())
            .collect();
        assert_eq!(
            permissions,
            CHANNELS.map(|(_, permission)| permission.to_owned())
        );
        // Each is a command of this file, named in build.rs so the ACL holds it.
        let build = include_str!("../build.rs");
        for (command, permission) in CHANNELS {
            assert_eq!(permission, format!("allow-{}", command.replace('_', "-")));
            assert!(build.contains(&format!("\"{command}\"")), "{command}");
        }
    }

    #[test]
    fn only_the_names_the_page_knows_are_keys() {
        for key in Key::ALL {
            assert_eq!(Key::parse(Some(&json!(key.name()))), Some(key));
        }
        for wrong in [
            json!("OpenAtLogin"),
            json!("open-at-login"),
            json!("openAtLogin "),
            json!("relay"),
            json!("server"),
            json!(""),
            json!(1),
            json!(true),
            json!(["openAtLogin"]),
            json!({ "key": "openAtLogin" }),
            Value::Null,
        ] {
            assert_eq!(Key::parse(Some(&wrong)), None, "{wrong}");
        }
        assert_eq!(Key::parse(None), None);
    }

    #[test]
    fn a_page_sets_at_once_only_push_to_talk_and_the_safe_way_of_three_switches() {
        use Key::*;
        // (key, wanted) → asks the person?
        for (key, wanted, asked) in [
            (PushToTalk, true, false),
            (PushToTalk, false, false),
            (OpenAtLogin, false, false),
            (KeepRunning, false, false),
            (ThisComputer, false, false),
            (OpenAtLogin, true, true),
            (KeepRunning, true, true),
            (ThisComputer, true, true),
            (PasswordManager, true, true),
            // Off removes every linked login.
            (PasswordManager, false, true),
        ] {
            assert_eq!(asks(key, wanted), asked, "{key:?} {wanted}");
            let expected = if asked { Plan::Ask } else { Plan::Flip };
            assert_eq!(
                plan(key, Some(!wanted), wanted),
                expected,
                "{key:?} {wanted}"
            );
            // Nothing happens when it is as asked already or not offered.
            assert_eq!(plan(key, Some(wanted), wanted), Plan::Nothing, "{key:?}");
            assert_eq!(plan(key, None, wanted), Plan::Nothing, "{key:?}");
        }
    }

    #[test]
    fn turning_push_to_talk_on_and_opening_a_window_are_held_to_once_in_their_gap() {
        assert!(TALK_GAP >= Duration::from_secs(30));
        assert!(OPEN_GAP >= Duration::from_secs(1));
        for gap in [TALK_GAP, OPEN_GAP] {
            let start = Instant::now();
            let mut last = None;
            assert!(once_per(&mut last, start, gap));
            // Five a second, as the budget alone would let through: only the first.
            for tenth in 1..10 {
                assert!(!once_per(&mut last, start + gap * tenth / 10, gap));
            }
            assert!(once_per(&mut last, start + gap, gap));
        }
    }

    #[test]
    fn a_refused_call_does_nothing_and_bad_input_is_refused_alike() {
        let off = |_: Key| Some(false);
        let on = json!(true);
        let key = json!("pushToTalk");
        assert_eq!(
            request(true, Some(&key), Some(&on), off),
            (Plan::Flip, Some(Key::PushToTalk))
        );
        assert_eq!(
            request(false, Some(&key), Some(&on), off),
            (Plan::Nothing, None)
        );
        let computer = json!("thisComputer");
        assert_eq!(
            request(false, Some(&computer), Some(&on), off),
            (Plan::Nothing, None)
        );
        for wrong in [json!("true"), json!(1), Value::Null, json!([true])] {
            assert_eq!(
                request(true, Some(&key), Some(&wrong), off),
                (Plan::Nothing, None),
                "{wrong}"
            );
        }
        assert_eq!(request(true, Some(&key), None, off), (Plan::Nothing, None));
        assert_eq!(request(true, None, Some(&on), off), (Plan::Nothing, None));
        // Opening: two things, for the chosen server's page only.
        assert_eq!(
            opens(true, Some(&json!("changeServer"))),
            Some("change-server")
        );
        assert_eq!(
            opens(true, Some(&json!("appSettings"))),
            Some(crate::prefs::MENU_ITEM_ID)
        );
        assert_eq!(opens(false, Some(&json!("changeServer"))), None);
        for wrong in [
            json!("change-server"),
            json!("back-up"),
            json!("quit"),
            json!("this-computer"),
            json!("https://evil.test/"),
            json!(true),
            Value::Null,
        ] {
            assert_eq!(opens(true, Some(&wrong)), None, "{wrong}");
        }
        assert_eq!(opens(true, None), None);
    }

    #[test]
    fn the_question_names_the_server_with_its_port() {
        assert_eq!(host(&url("https://dozo.example.com/")), "dozo.example.com");
        assert_eq!(host(&url("http://127.0.0.1:5173/")), "127.0.0.1:5173");
        assert_eq!(host(&url("http://[::1]:5173/")), "[::1]:5173");
    }

    fn server() -> Url {
        url("https://dozo.example.com/")
    }

    #[test]
    fn one_question_at_a_time_and_none_soon_after_the_last() {
        let start = Instant::now();
        let mut questions = Questions::new();
        let first = questions.put(Key::ThisComputer, true, server(), "first".into(), start);
        assert!(first.is_some());
        let shown = questions.open.as_ref().unwrap();
        assert_eq!(
            (shown.id, shown.key, shown.wanted),
            (first.unwrap(), Key::ThisComputer, true)
        );
        assert_eq!(shown.words, "first");
        // Another while it is open is dropped.
        assert_eq!(
            questions.put(Key::KeepRunning, true, server(), "second".into(), start),
            None
        );
        // Turn On: carried out, and nothing holds that switch back.
        let (allowed, carried) = questions.end(None, true, Some(&server()), start).unwrap();
        assert!(carried);
        assert_eq!((allowed.key, allowed.wanted), (Key::ThisComputer, true));
        assert!(questions.open.is_none());
        // Within the gap of the last question, nothing is asked, whatever it is.
        let soon = start + QUESTION_GAP / 2;
        assert_eq!(
            questions.put(Key::KeepRunning, true, server(), "x".into(), soon),
            None
        );
        let later = start + QUESTION_GAP;
        assert!(
            questions
                .put(Key::ThisComputer, true, server(), "x".into(), later)
                .is_some()
        );
    }

    #[test]
    fn a_refused_switch_is_not_asked_about_again_for_a_while() {
        let start = Instant::now();
        for refuse in ["cancel", "no answer", "window closed"] {
            let mut questions = Questions::new();
            let id = questions
                .put(Key::PasswordManager, false, server(), "q".into(), start)
                .unwrap();
            let ended = match refuse {
                "no answer" => questions.end(Some(id), false, Some(&server()), start),
                _ => questions.end(None, false, Some(&server()), start),
            };
            assert!(!ended.unwrap().1, "{refuse}");
            let after = |gap: Duration| start + QUESTION_GAP + gap;
            // The same switch, either way, is dropped; another switch may be asked.
            for wanted in [false, true] {
                let again = questions.put(
                    Key::PasswordManager,
                    wanted,
                    server(),
                    "q".into(),
                    after(Duration::ZERO),
                );
                assert_eq!(again, None, "{refuse}");
            }
            let other = questions.put(
                Key::KeepRunning,
                true,
                server(),
                "q".into(),
                after(Duration::ZERO),
            );
            assert!(other.is_some(), "{refuse}");
            questions.end(None, true, Some(&server()), after(Duration::ZERO));
            let later = start + ASK_AGAIN_AFTER + QUESTION_GAP;
            assert!(
                questions
                    .put(Key::PasswordManager, true, server(), "q".into(), later)
                    .is_some()
            );
        }
    }

    #[test]
    fn a_late_timeout_never_ends_a_later_question() {
        let start = Instant::now();
        let mut questions = Questions::new();
        let first = questions
            .put(Key::KeepRunning, true, server(), "a".into(), start)
            .unwrap();
        questions.end(None, true, Some(&server()), start);
        let later = start + QUESTION_GAP;
        questions
            .put(Key::OpenAtLogin, true, server(), "b".into(), later)
            .unwrap();
        assert!(
            questions
                .end(Some(first), false, Some(&server()), later)
                .is_none()
        );
        assert_eq!(questions.open.as_ref().unwrap().key, Key::OpenAtLogin);
    }

    #[test]
    fn an_answer_after_the_server_changed_counts_as_cancel() {
        let start = Instant::now();
        let mut questions = Questions::new();
        questions
            .put(Key::ThisComputer, true, server(), "q".into(), start)
            .unwrap();
        let other = url("https://other.example.com/");
        let (question, carried) = questions.end(None, true, Some(&other), start).unwrap();
        assert!(!carried);
        assert_eq!(question.key, Key::ThisComputer);
        // No server chosen at all: Cancel too, and it holds that switch back like one.
        let later = start + ASK_AGAIN_AFTER + QUESTION_GAP;
        questions
            .put(Key::KeepRunning, true, server(), "q".into(), later)
            .unwrap();
        assert!(!questions.end(None, true, None, later).unwrap().1);
        // The same server at another address on it (path) is the same origin.
        let much_later = later + ASK_AGAIN_AFTER + QUESTION_GAP;
        questions
            .put(Key::OpenAtLogin, true, server(), "q".into(), much_later)
            .unwrap();
        let same = url("https://dozo.example.com/space/1");
        assert!(
            questions
                .end(None, true, Some(&same), much_later)
                .unwrap()
                .1
        );
    }

    /// A section shown and closed again and again, with nothing changing meanwhile, leaves a read
    /// waiting each time: each new one must end the one before, so the last is answered.
    #[tokio::test]
    async fn a_new_read_ends_the_earlier_ones_so_the_last_stays_alive() {
        let reads: &'static Reads = Box::leak(Box::new(Reads::new()));
        let mut ended = Vec::new();
        for _ in 0..6 {
            let read = reads.start().expect("a new read always has room");
            ended.push(tokio::spawn(async move {
                // The whole read waits, its place among those waiting with it.
                let mut read = read;
                let _ = read.superseded.changed().await;
            }));
            tokio::task::yield_now().await;
        }
        let last = ended.pop().unwrap();
        for earlier in ended {
            tokio::time::timeout(Duration::from_secs(5), earlier)
                .await
                .expect("an earlier read ends")
                .unwrap();
        }
        assert!(!last.is_finished());
        assert_eq!(reads.waiting.load(Ordering::SeqCst), 1);
        // A page starting to load ends it too.
        reads.supersede();
        tokio::time::timeout(Duration::from_secs(5), last)
            .await
            .expect("the last read ends with the page")
            .unwrap();
        assert_eq!(reads.waiting.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn only_a_few_reads_wait_at_once_and_each_gives_its_place_back() {
        let count = AtomicUsize::new(0);
        let held: Vec<_> = (0..3).map(|_| Waiting::take(&count, 3).unwrap()).collect();
        assert!(Waiting::take(&count, 3).is_none());
        drop(held);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(Waiting::take(&count, 3).is_some());
    }

    #[test]
    fn the_question_has_cancel_first_and_focused_so_enter_never_allows() {
        let page = include_str!("../ui/confirm.html");
        let cancel = page.find(r#"id="cancel""#).unwrap();
        let allow = page.find(r#"id="allow""#).unwrap();
        assert!(cancel < allow);
        assert!(page[..allow].contains("autofocus"));
        let button = &page[page[..allow].rfind("<button").unwrap()..];
        assert!(button.contains("disabled"), "Allow starts disabled");
        let script = include_str!("../ui/confirm.js");
        assert!(script.contains(r#"el("cancel").focus()"#));
        assert!(script.contains("Escape"));
        assert!(script.contains(r#"invoke("confirm_answer""#));
        // Turn On is armed only while the window is on screen and in front.
        assert!(script.contains("document.hasFocus()"));
        assert!(script.contains(r#"addEventListener("blur", arm)"#));
        assert!(QUESTION_LIMIT <= Duration::from_secs(60));
    }

    #[test]
    fn the_budget_answers_a_burst_then_a_few_a_second() {
        let start = Instant::now();
        let mut budget = Budget::new();
        for call in 0..10 {
            assert!(budget.take(start), "{call}");
        }
        assert!(!budget.take(start));
        assert!(!budget.take(start + Duration::from_millis(100)));
        assert!(budget.take(start + Duration::from_millis(200)));
        assert!(!budget.take(start + Duration::from_millis(250)));
        // Refilled, never beyond the burst.
        let later = start + Duration::from_secs(60);
        for call in 0..10 {
            assert!(budget.take(later), "{call}");
        }
        assert!(!budget.take(later));
    }
}
