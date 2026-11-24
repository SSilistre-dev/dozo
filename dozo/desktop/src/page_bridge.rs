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
//! - Open at Login, Keep Running in Background and Push to Talk change at once. Let Bots Use This
//!   Computer and the password manager turn off at once (the safe way) and turn on only after the
//!   person allows it in a window of the app's own (`ui/confirm.html`, [`ask`]), and then through
//!   the menu's own question. The page never gives an address, a path, a shortcut or any text.
//!
//! The server is chosen while the app runs, and a capability file is fixed when the app is built,
//! so no file can name it: [`admit`] grants these three commands to one origin, the chosen
//! server's, once its page starts loading in the window. Tauri can add a capability but never take
//! one back, so each command also checks the caller itself ([`caller`]): the window's own page,
//! on the origin that is chosen now. An earlier server keeps its grant until the app ends and is
//! refused here. A frame inside the page never has the bridge: Tauri gives its call key, and the
//! app its bridge (`SHELL_MARK` in main.rs), to the window's own page only.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::ipc::CapabilityBuilder;
use tauri::{
    AppHandle, Manager, Url, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::oneshot;

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

    /// On lets the server do something on this computer: only the person turns it on.
    fn sensitive(self) -> bool {
        matches!(self, Key::ThisComputer | Key::PasswordManager)
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

/// `now` is the switch's state, none while the menu does not offer it.
fn plan(key: Key, now: Option<bool>, wanted: bool) -> Plan {
    match now {
        Some(now) if now != wanted && wanted && key.sensitive() => Plan::Ask,
        Some(now) if now != wanted => Plan::Flip,
        _ => Plan::Nothing,
    }
}

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
pub fn admit(app: &AppHandle, server: &Url) {
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
#[tauri::command]
pub async fn desktop_settings(app: AppHandle, webview: Webview, seen: Option<Value>) -> Value {
    if !allowed(&app, &webview) {
        return Value::Null;
    }
    let mut changes = crate::prefs::watch(&app);
    loop {
        changes.borrow_and_update();
        let now = state(&app);
        if seen.as_ref() != Some(&now) || changes.changed().await.is_err() {
            // Asked again: the page may have gone elsewhere while this waited.
            return if from_page(&app, &webview) {
                now
            } else {
                Value::Null
            };
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
            let wanted = on.as_ref().and_then(Value::as_bool) == Some(true);
            flip(&app, key, wanted).await;
        }
        (Plan::Ask, Some(key)) => ask(&app, key),
        _ => {}
    }
}

/// Opens what only the app may show: the screen to choose another server, or the app's own
/// Settings window (the logins of the password manager). Answers nothing, whatever happened.
#[tauri::command]
pub async fn desktop_open(app: AppHandle, webview: Webview, what: Option<Value>) {
    if let Some(id) = opens(allowed(&app, &webview), what.as_ref()) {
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
const QUESTION_WINDOW: &str = "confirm";

/// The question on screen, if any: one at a time, and a request while one is open is dropped.
struct Question {
    id: u64,
    key: Key,
    words: String,
}

static QUESTION: Mutex<Option<Question>> = Mutex::new(None);
static QUESTIONS: AtomicU64 = AtomicU64::new(0);

/// Puts the question up; none when one is already open.
fn put(open: &mut Option<Question>, key: Key, words: String) -> Option<u64> {
    if open.is_some() {
        return None;
    }
    let id = QUESTIONS.fetch_add(1, Ordering::SeqCst);
    *open = Some(Question { id, key, words });
    Some(id)
}

/// The page asked to turn a sensitive switch on: the app asks the person in its own window.
fn ask(app: &AppHandle, key: Key) {
    let label = crate::switch_item(app, key.menu_id())
        .and_then(|item| item.text().ok())
        .unwrap_or_default();
    let host = crate::chosen(app)
        .and_then(|server| server.host_str().map(str::to_owned))
        .unwrap_or_default();
    let words = text("{host} asks to turn on “{label}”.")
        .replace("{host}", &host)
        .replace("{label}", &label);
    let Some(id) = put(&mut QUESTION.lock().unwrap(), key, words) else {
        return;
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || show_question(&handle));
    // Unanswered in time: Cancel.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(QUESTION_LIMIT).await;
        if QUESTION
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|open| open.id == id)
        {
            answer(&handle, false);
        }
    });
}

/// The person's answer, or Cancel; only the first one counts, and the window closes with it.
fn answer(app: &AppHandle, allow: bool) {
    let Some(open) = QUESTION.lock().unwrap().take() else {
        return;
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(QUESTION_WINDOW) {
            let _ = window.destroy();
        }
    });
    if allow {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { flip(&app, open.key, true).await });
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
                    answer(&app, false);
                }
            });
            let _ = window.set_focus();
        }
        Err(error) => {
            eprintln!("dozo: could not open the question: {error}");
            answer(app, false);
        }
    }
}

/// What the question's window shows. Every word comes from the app, in the system's language.
#[tauri::command]
pub fn confirm_question() -> Option<Value> {
    let open = QUESTION.lock().unwrap();
    open.as_ref().map(|open| {
        json!({
            "lang": if crate::words::turkish() { "tr" } else { "en" },
            "question": open.words,
            "allow": text("Turn On"),
            "cancel": text("Cancel"),
        })
    })
}

/// The person's answer in the question's window (`capabilities/confirm.json`).
#[tauri::command]
pub fn confirm_answer(window: WebviewWindow, allow: Option<Value>) {
    answer(window.app_handle(), allow == Some(Value::Bool(true)));
}

/// The app is quitting: an open question goes with it, as Cancel.
pub fn close(app: &AppHandle) {
    answer(app, false);
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
    fn a_sensitive_switch_is_never_turned_on_without_the_person() {
        for key in Key::ALL {
            // Off is always at once, and nothing happens when it is as asked or not offered.
            assert_eq!(plan(key, Some(true), false), Plan::Flip, "{key:?}");
            assert_eq!(plan(key, Some(true), true), Plan::Nothing, "{key:?}");
            assert_eq!(plan(key, Some(false), false), Plan::Nothing, "{key:?}");
            assert_eq!(plan(key, None, true), Plan::Nothing, "{key:?}");
            assert_eq!(plan(key, None, false), Plan::Nothing, "{key:?}");
            let on = plan(key, Some(false), true);
            if key.sensitive() {
                assert_eq!(on, Plan::Ask, "{key:?}");
            } else {
                assert_eq!(on, Plan::Flip, "{key:?}");
            }
        }
        assert!(Key::ThisComputer.sensitive() && Key::PasswordManager.sensitive());
        assert!(!Key::OpenAtLogin.sensitive());
        assert!(!Key::KeepRunning.sensitive() && !Key::PushToTalk.sensitive());
    }

    #[test]
    fn a_refused_call_does_nothing_and_bad_input_is_refused_alike() {
        let off = |_: Key| Some(false);
        let on = json!(true);
        let key = json!("openAtLogin");
        assert_eq!(
            request(true, Some(&key), Some(&on), off),
            (Plan::Flip, Some(Key::OpenAtLogin))
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
    fn one_question_at_a_time() {
        let mut open = None;
        let first = put(&mut open, Key::ThisComputer, "first".into());
        assert!(first.is_some());
        assert_eq!(put(&mut open, Key::PasswordManager, "second".into()), None);
        let shown = open.as_ref().unwrap();
        assert_eq!((shown.id, shown.key), (first.unwrap(), Key::ThisComputer));
        assert_eq!(shown.words, "first");
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
