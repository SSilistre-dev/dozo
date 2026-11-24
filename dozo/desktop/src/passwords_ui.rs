//! The password manager's side of the app's own screens: the switch in the Dozo menu and its
//! question, the question before a login is first filled on a site, and the commands the Settings
//! window uses to link and remove logins (`capabilities/prefs.json`). What the links are and how
//! a fill works is `password_links.rs` and `browser_fill.rs`; this file only asks the person and
//! tells the server.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::oneshot;

use crate::device::Access;
use crate::password_links::{FillPrompt, HttpRegistry, Passwords, Registry};
use crate::password_manager::Fut;
use crate::words::text;

pub const MENU_ID: &str = "password-manager";
pub const LABEL: &str = "Password Manager";

/// Asks in the app's own dialog, never in the page.
pub struct DialogFill(pub AppHandle);

impl FillPrompt for DialogFill {
    fn ask(&self, title: &str, origin: &str) -> oneshot::Receiver<bool> {
        let (answer, answered) = oneshot::channel();
        let question = text("Fill your {title} login on {origin}?")
            .replace("{title}", title)
            .replace("{origin}", origin);
        self.0
            .dialog()
            .message(question)
            .title("Dozo")
            .buttons(MessageDialogButtons::OkCancelCustom(
                text("Allow").to_owned(),
                text("Cancel").to_owned(),
            ))
            .show(move |allowed| {
                let _ = answer.send(allowed);
            });
        answered
    }
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
            "Bots can fill the logins you link in their own browser on this computer. Passwords are read here when needed and never leave it.",
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
