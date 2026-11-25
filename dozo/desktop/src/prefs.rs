//! Settings (Dozo → Settings…, Cmd+, or Ctrl+,): a small window that lists what the Dozo menu
//! offers right now, switches first, then the version and, while the server on this computer
//! runs, its licenses. The list is read from the menu itself, so a new item there shows here
//! too, under the same words and in the same state; an item that is off (Back Up… while no server
//! runs on this computer) is left out. Picking a row does what picking the item does
//! (`crate::run`). The window's page (`ui/prefs.html`) only this window loads, and only it may
//! call these commands (`capabilities/prefs.json`).
//!
//! A page of the chosen server can open this window, and do nothing else with it, by going to
//! [`APP_SETTINGS`](crate::server::APP_SETTINGS) (the web app's "Desktop app" row): see
//! [`asked_by_page`].

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::menu::MenuItemKind;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::watch;

use crate::server::is_local;
use crate::stack::Status;
use crate::{LocalServer, MENU_ID, chosen, update, words};

const WINDOW: &str = "prefs";
/// The menu item that opens this window.
pub const MENU_ITEM_ID: &str = "settings";
/// Menu items that are not settings: they stay in the menu only.
const LEFT_OUT: [&str; 3] = [MENU_ITEM_ID, "reload", "quit"];
/// The row for the licenses of the server on this computer.
const LICENSES_ID: &str = "licenses";
/// Where that server keeps them (`dozo/server-bundle/notices.mjs`).
const NOTICES_PAGE: &str = "third-party-notices.html";

/// Bumped whenever something the list shows may have changed, so an open window reads it again.
pub struct Changes(watch::Sender<u64>);

impl Default for Changes {
    fn default() -> Self {
        Changes(watch::Sender::new(0))
    }
}

/// Follows what [`changed`] says, for the web app's section of these settings (`page_bridge.rs`).
pub fn watch(app: &AppHandle) -> watch::Receiver<u64> {
    app.state::<Changes>().0.subscribe()
}

/// Something the list shows may have changed (a switch, an item turned on or off).
pub fn changed(app: &AppHandle) {
    if let Some(changes) = app.try_state::<Changes>() {
        changes.0.send_modify(|count| *count += 1);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    id: String,
    label: String,
    /// A switch's state; none for an action.
    on: Option<bool>,
}

impl Row {
    fn to_json(&self) -> Value {
        match self.on {
            Some(on) => json!({ "id": self.id, "label": self.label, "on": on }),
            None => json!({ "id": self.id, "label": self.label }),
        }
    }
}

/// What the window lists now. Reads the menu, so call it off the main thread or on it, never
/// while holding something the main thread waits for.
fn rows(app: &AppHandle) -> Vec<Row> {
    let mut items = Vec::new();
    if let Some(MenuItemKind::Submenu(menu)) = app.menu().and_then(|menu| menu.get(MENU_ID)) {
        items.extend(menu.items().unwrap_or_default());
    }
    // Restart to Update sits in a menu of its own once an update is waiting.
    if let Some(MenuItemKind::Submenu(holder)) =
        app.menu().and_then(|menu| menu.get(update::MENU_HOLDER_ID))
    {
        items.extend(holder.get(update::MENU_ID));
    }
    let mut rows = listed(items.iter().filter_map(|item| match item {
        MenuItemKind::MenuItem(item) => Some((
            item.id().0.clone(),
            item.text().ok()?,
            item.is_enabled().ok()?,
            None,
        )),
        MenuItemKind::Check(item) => Some((
            item.id().0.clone(),
            item.text().ok()?,
            item.is_enabled().ok()?,
            item.is_checked().ok(),
        )),
        _ => None,
    }));
    if licenses(app).is_some() {
        rows.push(Row {
            id: LICENSES_ID.into(),
            label: words::text("Licenses").into(),
            on: None,
        });
    }
    rows
}

/// The rows for the menu's items (id, words, on, checked), in the menu's order with the
/// switches first: items that are off and those that are not settings are left out.
fn listed(items: impl Iterator<Item = (String, String, bool, Option<bool>)>) -> Vec<Row> {
    let (mut switches, actions): (Vec<Row>, Vec<Row>) = items
        .filter(|(id, _, enabled, _)| *enabled && !LEFT_OUT.contains(&id.as_str()))
        .map(|(id, label, _, on)| Row { id, label, on })
        .partition(|row| row.on.is_some());
    switches.extend(actions);
    switches
}

/// The licenses page of the server on this computer, while it runs.
fn licenses(app: &AppHandle) -> Option<Url> {
    let ready = match &*app.state::<LocalServer>().0.status().borrow() {
        Status::Ready(url) => Url::parse(url).ok(),
        _ => None,
    };
    ready?.join(NOTICES_PAGE).ok()
}

fn list(app: &AppHandle) -> Value {
    json!({
        "title": words::text("Settings"),
        "version": format!("{} {}", words::text("Version"), app.package_info().version),
        "lang": if words::turkish() { "tr" } else { "en" },
        "rows": rows(app).iter().map(Row::to_json).collect::<Vec<_>>(),
        // Only while the password manager is on.
        "logins": crate::passwords_ui::section(app),
    })
}

/// The list, once it differs from `seen` (what the window shows now): the window asks again after
/// each answer, and nothing is asked on a timer.
#[tauri::command]
pub async fn prefs_list(app: AppHandle, seen: Option<Value>) -> Value {
    let mut changes = app.state::<Changes>().0.subscribe();
    loop {
        changes.borrow_and_update();
        let now = list(&app);
        if seen.as_ref() != Some(&now) || changes.changed().await.is_err() {
            return now;
        }
    }
}

/// A row was picked: what picking its menu item does. Only a row the list shows now may be
/// picked. A switch flips first, as the menu flips it before saying so.
#[tauri::command]
pub async fn prefs_pick(app: AppHandle, id: String) -> Result<(), String> {
    if !rows(&app).iter().any(|row| row.id == id) {
        return Err("gone".into());
    }
    if id == LICENSES_ID {
        if let Some(page) = licenses(&app) {
            crate::open_outside(page);
        }
        return Ok(());
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let app = &handle;
        if let Some(MenuItemKind::Check(item)) = app
            .menu()
            .and_then(|menu| menu.get(MENU_ID))
            .and_then(|menu| match menu {
                MenuItemKind::Submenu(menu) => menu.get(&id),
                _ => None,
            })
        {
            let _ = item.set_checked(!item.is_checked().unwrap_or(false));
        }
        crate::run(app, &id);
    })
    .map_err(|error| error.to_string())
}

/// Opens the window, or brings it forward.
pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("prefs.html".into()))
        .title(words::text("Settings"))
        .inner_size(380.0, 600.0)
        .min_inner_size(320.0, 320.0)
        .center()
        // Only its own page loads here.
        .on_navigation(is_local)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    match built {
        // Windows and Linux put the app's menu in every window; this one has none.
        Ok(window) => {
            #[cfg(not(target_os = "macos"))]
            let _ = window.remove_menu();
            #[cfg(target_os = "macos")]
            let _ = window;
        }
        Err(error) => eprintln!("dozo: could not open Settings: {error}"),
    }
}

pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
}

/// The app window's page went to [`APP_SETTINGS`](crate::server::APP_SETTINGS). It opens this
/// window when that page is the chosen server's, at most once a second; nothing else happens,
/// whatever the page.
pub fn asked_by_page(app: &AppHandle) {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let page = app
        .get_webview_window("main")
        .and_then(|window| window.url().ok());
    if !from_server(page.as_ref(), chosen(app).as_ref())
        || !once_a_second(&mut LAST.lock().unwrap(), Instant::now())
    {
        return;
    }
    // Not from inside the web view's own question: the window opens once it has its answer.
    // Asked from the main thread, `run_on_main_thread` would run it at once, so it is asked from
    // a task.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || open(&app));
    });
}

/// Whether the page shown is one of the chosen server's.
pub fn from_server(page: Option<&Url>, server: Option<&Url>) -> bool {
    match (page, server) {
        (Some(page), Some(server)) => {
            matches!(page.scheme(), "http" | "https") && page.origin() == server.origin()
        }
        _ => false,
    }
}

/// True, and noted, unless the last time was less than a second ago.
fn once_a_second(last: &mut Option<Instant>, now: Instant) -> bool {
    if last.is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(1)) {
        return false;
    }
    *last = Some(now);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn item(id: &str, enabled: bool, on: Option<bool>) -> (String, String, bool, Option<bool>) {
        (id.into(), format!("{id} label"), enabled, on)
    }

    #[test]
    fn lists_the_items_that_are_on_with_the_switches_first() {
        let rows = listed(
            [
                item("settings", true, None),
                item("change-server", true, None),
                item("reload", true, None),
                item("connect-phone", false, None),
                item("this-computer", true, Some(false)),
                item("back-up", true, None),
                item("open-at-login", true, Some(true)),
                // A switch another change adds to the menu shows up as well.
                item("talk-shortcut", true, Some(false)),
                item("quit", true, None),
                item("update", true, None),
            ]
            .into_iter(),
        );
        let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "this-computer",
                "open-at-login",
                "talk-shortcut",
                "change-server",
                "back-up",
                "update"
            ]
        );
        assert_eq!(rows[1].on, Some(true));
        assert_eq!(rows[3].on, None);
        assert_eq!(rows[3].label, "change-server label");
    }

    #[test]
    fn only_a_page_of_the_chosen_server_opens_the_window() {
        let server = url("https://dozo.example.com/");
        let from = |page: &str| from_server(Some(&url(page)), Some(&server));
        assert!(from("https://dozo.example.com/settings?section=general"));
        for other in [
            "https://evil.test/",
            "http://dozo.example.com/",
            "https://dozo.example.com:8443/",
            "https://dozo.example.com.evil.test/",
            "tauri://localhost/index.html",
            "about:blank",
            "data:text/html,x",
        ] {
            assert!(!from(other), "{other}");
        }
        assert!(!from_server(None, Some(&server)));
        assert!(!from_server(Some(&server), None));
        // A server on this computer is plain http.
        let local = url("http://127.0.0.1:4545/");
        assert!(from_server(
            Some(&url("http://127.0.0.1:4545/x")),
            Some(&local)
        ));
    }

    #[test]
    fn opens_at_most_once_a_second() {
        let start = Instant::now();
        let mut last = None;
        assert!(once_a_second(&mut last, start));
        assert!(!once_a_second(
            &mut last,
            start + Duration::from_millis(999)
        ));
        assert!(once_a_second(&mut last, start + Duration::from_secs(1)));
        assert!(!once_a_second(
            &mut last,
            start + Duration::from_millis(1500)
        ));
    }
}
