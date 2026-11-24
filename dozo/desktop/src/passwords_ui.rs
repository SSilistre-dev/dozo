//! The password manager's side of the app's own screens: the switch in the Dozo menu and its
//! question, the question before a login is first filled on a site, and the commands the Settings
//! window uses to link and remove logins (`capabilities/prefs.json`). What the links are and how
//! a fill works is `password_links.rs` and `browser_fill.rs`; this file only asks the person and
//! tells the server.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::oneshot;

use crate::device::Access;
use crate::password_links::{FillPrompt, HttpRegistry, Passwords, Registry};
use crate::password_manager::Fut;
use crate::question_slot::Slot;
use crate::words::text;

pub const MENU_ID: &str = "password-manager";
pub const LABEL: &str = "Password Manager";

/// Asks in a small window of the app's own (`ui/fill.html`), never in the page. A system dialog
/// cannot be closed from here, and this question must go when the request it is for ends (the
/// server cancelled it, or nobody answered in time): that counts as Cancel.
pub struct DialogFill(pub AppHandle);

const FILL_WINDOW: &str = "fill";

/// The question on screen (title and site); the logic is the one `agent_ui.rs` shares
/// (`question_slot.rs`).
#[derive(Default)]
pub struct FillQuestion(Slot<(String, String)>);

impl FillQuestion {
    fn put(&self, title: &str, origin: &str) -> (u64, oneshot::Receiver<bool>) {
        self.0.put((title.to_owned(), origin.to_owned()))
    }

    fn words(&self) -> Option<(u64, String, String)> {
        self.0
            .open()
            .map(|(id, (title, origin))| (id, title, origin))
    }

    fn answer(&self, id: u64, allow: bool) -> bool {
        self.0.answer(id, allow)
    }

    fn window_gone(&self) {
        self.0.window_gone();
    }

    fn retire_window(&self) -> bool {
        self.0.retire_window()
    }

    fn window_opened(&self) {
        self.0.window_opened();
    }

    fn end(&self, id: u64) -> bool {
        self.0.end(id)
    }
}

/// Passes the window's answer on to whoever asked, until nobody waits for it any more (the
/// receiver was dropped: the request was cancelled or timed out). A window that goes without an
/// answer is Cancel.
pub(crate) async fn relay(mut asked: oneshot::Sender<bool>, page: oneshot::Receiver<bool>) {
    tokio::select! {
        () = asked.closed() => {}
        allow = page => {
            let _ = asked.send(allow.unwrap_or(false));
        }
    }
}

impl FillPrompt for DialogFill {
    fn ask(&self, title: &str, origin: &str) -> oneshot::Receiver<bool> {
        let (asked, answered) = oneshot::channel();
        let app = self.0.clone();
        let (id, page) = app.state::<FillQuestion>().put(title, origin);
        let shown = app.clone();
        let _ = app.run_on_main_thread(move || show_question(&shown));
        tauri::async_runtime::spawn(async move {
            relay(asked, page).await;
            if app.state::<FillQuestion>().end(id) {
                let _ = app.run_on_main_thread({
                    let app = app.clone();
                    move || {
                        if !app.state::<FillQuestion>().retire_window() {
                            return;
                        }
                        if let Some(window) = app.get_webview_window(FILL_WINDOW) {
                            let _ = window.destroy();
                        }
                    }
                });
            }
        });
        answered
    }
}

/// Opens the question's window, or has the one open ask again.
fn show_question(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(FILL_WINDOW) {
        let _ = window.eval("location.reload()");
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, FILL_WINDOW, WebviewUrl::App("fill.html".into()))
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
            app.state::<FillQuestion>().window_opened();
            #[cfg(not(target_os = "macos"))]
            let _ = window.remove_menu();
            let app = app.clone();
            // Closing the window without answering is Cancel.
            window.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    app.state::<FillQuestion>().window_gone();
                }
            });
            let _ = window.set_focus();
        }
        // No window: the question cannot be answered, which is Cancel.
        Err(error) => {
            eprintln!("dozo: could not open the question: {error}");
            app.state::<FillQuestion>().window_gone();
        }
    }
}

/// What the question's window shows. Every word comes from the app, in the system's language.
#[tauri::command]
pub fn fill_question(question: State<'_, FillQuestion>) -> Option<Value> {
    let (id, title, origin) = question.words()?;
    Some(json!({
        "id": id,
        "lang": if crate::words::turkish() { "tr" } else { "en" },
        "question": text("Fill your {title} login on {origin}?")
            .replace("{title}", &title)
            .replace("{origin}", &origin),
        "allow": text("Allow"),
        "cancel": text("Cancel"),
    }))
}

/// The person's answer to the question `id` the window showed; the window closes with it. An
/// answer to a question that is no longer the open one is ignored.
#[tauri::command]
pub fn fill_answer(window: WebviewWindow, question: State<'_, FillQuestion>, id: u64, allow: bool) {
    question.answer(id, allow);
    let _ = window.close();
}

/// What the server is told with when this computer is not paired: nothing is, and every call says
/// so.
struct Offline;

impl Registry for Offline {
    fn register(&self, _: &str, _: &str, _: &str) -> Fut<'_, bool> {
        Box::pin(async { false })
    }

    fn unregister(&self, _: &str) -> Fut<'_, bool> {
        Box::pin(async { false })
    }
}

fn passwords(app: &AppHandle) -> Arc<Passwords> {
    app.state::<Access>().runner().passwords().clone()
}

/// The server's side of a link, as the paired computer; none while it is not paired.
async fn registry(app: &AppHandle) -> Box<dyn Registry> {
    match crate::device::credentials(app).await {
        Some((server, token)) => Box::new(HttpRegistry { server, token }),
        None => Box::new(Offline),
    }
}

/// The saved choice at launch: off forgets every link an earlier run left.
pub fn start(app: &AppHandle, on: bool) {
    passwords(app).start(on);
}

/// The menu's switch was flipped (it holds the new choice). On asks first, and only turns on
/// where the program is; off is at once and ends every link.
pub fn flipped(app: &AppHandle, wanted: bool) {
    let handle = app.clone();
    if !wanted {
        tauri::async_runtime::spawn(async move { turn(&handle, false).await });
        return;
    }
    show_switch(app, false);
    if passwords(app).vault().is_none() {
        message(
            app,
            text("No supported password manager was found on this computer."),
        );
        return;
    }
    app.dialog()
        .message(text(
            "Bots can fill the logins you link in their own browser on this computer. Passwords are read here when needed and typed only into the site they belong to; the bot gets no picture of a page while a filled password is on it.",
        ))
        .title(text("Use your password manager?"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            text("Turn On").to_owned(),
            text("Cancel").to_owned(),
        ))
        .show(move |yes| {
            if yes {
                tauri::async_runtime::spawn(async move { turn(&handle, true).await });
            }
        });
}

fn message(app: &AppHandle, words: &str) {
    app.dialog()
        .message(words)
        .title("Dozo")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

fn show_switch(app: &AppHandle, on: bool) {
    if let Some(item) = crate::switch_item(app, MENU_ID) {
        let _ = item.set_checked(on);
    }
}

/// Turns the setting on or off, saves it and lets the server know what this computer offers
/// now. Off ends every link here and on the server, from this moment.
async fn turn(app: &AppHandle, on: bool) {
    let passwords = passwords(app);
    crate::set_password_manager(app, on);
    if on {
        passwords.set_enabled(true);
    } else {
        passwords.turn_off(registry(app).await.as_ref()).await;
    }
    show_switch(app, on);
    // The capability goes out when the computer connects.
    crate::device::select(app, crate::chosen(app));
    crate::prefs::changed(app);
}

/// What the Settings window shows of the logins: nothing while the setting is off.
pub fn section(app: &AppHandle) -> Option<Value> {
    let passwords = passwords(app);
    passwords.enabled().then(|| {
        let items: Vec<Value> = passwords
            .links()
            .list()
            .into_iter()
            .map(|(handle, link)| {
                json!({ "handle": handle, "title": link.title, "site": link.origin })
            })
            .collect();
        json!({
            "heading": text("Logins"),
            "link": text("Link a login…"),
            "remove": text("Remove"),
            "none": text("No logins found."),
            "items": items,
        })
    })
}

fn enabled(app: &AppHandle) -> Result<Arc<Passwords>, String> {
    let passwords = passwords(app);
    if passwords.enabled() {
        Ok(passwords)
    } else {
        Err(text("Could not read your logins.").to_owned())
    }
}

/// The logins the program lists (title and site only), for the picker.
#[tauri::command]
pub async fn logins_candidates(app: AppHandle) -> Result<Value, String> {
    let passwords = enabled(&app)?;
    let logins = passwords
        .candidates()
        .await
        .map_err(|_| text("Could not read your logins.").to_owned())?;
    Ok(Value::Array(
        logins
            .into_iter()
            .map(|login| json!({ "item": login.item, "title": login.title, "site": login.site }))
            .collect(),
    ))
}

/// Links the login the person picked, by the id the list gave.
#[tauri::command]
pub async fn logins_link(app: AppHandle, item: String) -> Result<(), String> {
    let passwords = enabled(&app)?;
    let linked = passwords.link(&item, registry(&app).await.as_ref()).await;
    crate::prefs::changed(&app);
    linked.map_err(|_| text("Could not link this login.").to_owned())
}

/// Removes a link here, then on the server.
#[tauri::command]
pub async fn logins_remove(app: AppHandle, handle: String) -> Result<(), String> {
    let passwords = enabled(&app)?;
    passwords
        .unlink(&handle, registry(&app).await.as_ref())
        .await;
    crate::prefs::changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const FIVE: Duration = Duration::from_secs(5);

    #[test]
    fn cancel_comes_first_and_has_the_focus_so_enter_never_allows() {
        let page = include_str!("../ui/fill.html");
        let cancel = page.find(r#"id="cancel""#).unwrap();
        let allow = page.find(r#"id="allow""#).unwrap();
        assert!(cancel < allow);
        assert!(page[..allow].contains("autofocus"));
        let button = &page[page[..allow].rfind("<button").unwrap()..allow];
        assert!(!button.contains("autofocus"), "{button}");
        let script = include_str!("../ui/fill.js");
        assert!(script.contains(r#"el("cancel").focus()"#));
        assert!(script.contains("Escape"));
    }

    #[test]
    fn the_window_answers_for_the_question_it_shows() {
        let script = include_str!("../ui/fill.js");
        assert!(script.contains("id: shown?.id ?? 0"));
        let question = FillQuestion::default();
        let (_, _page) = question.put("Bank", "https://bank.example.com");
        assert!(!question.answer(0, true));
        assert!(question.words().is_some());
    }

    #[tokio::test]
    async fn the_windows_answer_reaches_whoever_asked() {
        for allow in [true, false] {
            let question = FillQuestion::default();
            let (asked, answered) = oneshot::channel();
            let (id, page) = question.put("Bank", "https://bank.example.com");
            let relaying = tokio::spawn(relay(asked, page));
            assert_eq!(
                question.words(),
                Some((id, "Bank".to_owned(), "https://bank.example.com".to_owned()))
            );
            assert!(question.answer(id, allow));
            // A second answer changes nothing.
            assert!(!question.answer(id, !allow));
            assert_eq!(
                tokio::time::timeout(FIVE, answered).await.unwrap(),
                Ok(allow)
            );
            relaying.await.unwrap();
            assert_eq!(question.words(), None);
        }
    }

    #[tokio::test]
    async fn a_window_that_goes_without_an_answer_is_cancel() {
        let question = FillQuestion::default();
        let (asked, answered) = oneshot::channel();
        let (_, page) = question.put("Bank", "https://bank.example.com");
        tokio::spawn(relay(asked, page));
        // Another question takes its place: the first counts as Cancel.
        question.put("Shop", "https://shop.example.com");
        assert_eq!(
            tokio::time::timeout(FIVE, answered).await.unwrap(),
            Ok(false)
        );
    }

    #[tokio::test]
    async fn the_question_ends_when_nobody_waits_for_the_answer_any_more() {
        let question = FillQuestion::default();
        let (asked, answered) = oneshot::channel();
        let (id, page) = question.put("Bank", "https://bank.example.com");
        let relaying = tokio::spawn(relay(asked, page));
        // The request was cancelled or timed out: its receiver is gone.
        drop(answered);
        tokio::time::timeout(FIVE, relaying).await.unwrap().unwrap();
        // Only the question on screen is ended, never a later one.
        let (_, _later) = question.put("Shop", "https://shop.example.com");
        assert!(!question.end(id));
        assert!(question.words().is_some());
        let (current, _page) = question.put("Shop", "https://shop.example.com");
        assert!(question.end(current));
        assert_eq!(question.words(), None);
    }

    #[test]
    fn an_answer_for_a_question_that_is_no_longer_open_does_nothing() {
        let question = FillQuestion::default();
        let (first, _gone) = question.put("Bank", "https://bank.example.com");
        let (second, mut answered) = question.put("Shop", "https://shop.example.com");
        // The window still shows the first question: its Allow must not approve the second.
        assert!(!question.answer(first, true));
        assert_eq!(
            answered.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        assert!(question.words().is_some());
        assert!(question.answer(second, true));
        assert_eq!(answered.try_recv(), Ok(true));
    }

    #[test]
    fn a_window_retired_for_an_ended_question_never_cancels_the_next() {
        let question = FillQuestion::default();
        let (first, _page) = question.put("Bank", "https://bank.example.com");
        assert!(question.end(first));
        assert!(question.retire_window());
        // The next question arrives before the old window's destroy event does.
        let (_, mut answered) = question.put("Shop", "https://shop.example.com");
        question.window_gone();
        assert_eq!(
            answered.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        assert!(question.words().is_some());
        // A window the person closes is still Cancel.
        question.window_gone();
        assert_eq!(answered.try_recv(), Ok(false));
    }

    #[test]
    fn a_question_that_arrived_before_the_retiring_keeps_its_window() {
        let question = FillQuestion::default();
        let (first, _page) = question.put("Bank", "https://bank.example.com");
        assert!(question.end(first));
        question.put("Shop", "https://shop.example.com");
        assert!(!question.retire_window());
    }
}
