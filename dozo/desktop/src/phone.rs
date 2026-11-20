//! Connect Phone: a small window with a QR code that pairs a phone with the server on this
//! computer through the relay agent (`stack.rs`), the account it signs in as, and the phones
//! already paired. Once a phone scans the code, the window asks whether to connect it, with the
//! kind of phone and the code it shows; the phone gets its sign-in only after Allow, and the
//! window closes. The item in the Dozo menu is on only while that server runs with an agent. Its page is `ui/phone.html`, which only this window loads
//! and whose commands only it may call (`capabilities/phone.json`).

use std::time::Duration;

use serde_json::{Value, json};
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::device::Window;
use crate::device_pairing::SignIn;
use crate::server::is_local;
use crate::stack::{Agent, Status, event_channel};
use crate::{LocalServer, chosen};

pub const MENU_ID: &str = "connect-phone";
const WINDOW: &str = "phone";

/// The menu item, kept to switch it on and off.
pub struct Item(pub MenuItem<Wry>);

pub fn item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let item = MenuItem::with_id(app, MENU_ID, "Connect Phone…", false, None::<&str>)?;
    app.manage(Item(item.clone()));
    Ok(item)
}

/// Keeps the menu item in step with the server, and closes the window when the server stops.
pub fn follow(app: AppHandle) {
    let local = app.state::<LocalServer>().0.clone();
    let mut status = local.status();
    tauri::async_runtime::spawn(async move {
        loop {
            let ready = matches!(*status.borrow_and_update(), Status::Ready(_));
            let on = ready && local.agent().await.is_some();
            if let Some(item) = app.try_state::<Item>() {
                let _ = item.0.set_enabled(on);
            }
            if !on {
                close(&app);
            }
            if status.changed().await.is_err() {
                return;
            }
        }
    });
}

pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
}

/// Opens the window, or brings it forward.
pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("phone.html".into()))
        .title("Connect Phone")
        .inner_size(340.0, 500.0)
        .resizable(false)
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
        Err(error) => eprintln!("dozo: could not open Connect Phone: {error}"),
    }
}

async fn agent(app: &AppHandle) -> Result<Agent, String> {
    let local = app.state::<LocalServer>().0.clone();
    local.agent().await.ok_or_else(|| "off".to_owned())
}

/// A new code for the account signed in on this computer, or `{"state":"signed-out"}`.
#[tauri::command]
pub async fn phone_code(app: AppHandle) -> Result<Value, String> {
    let agent = agent(&app).await?;
    let server = chosen(&app).ok_or("off")?;
    let Some(account) = account(&app, &server).await else {
        return Ok(json!({ "state": "signed-out" }));
    };
    let offer = agent.offer().await?;
    let (size, cells) = qr(&offer.qr)?;
    Ok(json!({
        "state": "code",
        "channel": offer.channel,
        "account": account,
        "expiresAt": offer.expires_at,
        "size": size,
        "cells": cells,
    }))
}

/// The phones paired with this computer.
#[tauri::command]
pub async fn phones(app: AppHandle) -> Result<Value, String> {
    let phones = agent(&app).await?.phones().await?;
    Ok(phones
        .into_iter()
        .map(|phone| json!({ "channel": phone.channel, "pairedAt": phone.paired_at }))
        .collect())
}

/// Removes a paired phone, or refuses the one that just scanned the code.
#[tauri::command]
pub async fn remove_phone(app: AppHandle, channel: String) -> Result<(), String> {
    agent(&app).await?.remove(&channel).await
}

/// Waits until the phone that scanned the code on `channel` asks to be allowed (its platform and
/// the code it shows), or its pairing ran out (`expired`). Nothing is asked on a timer.
#[tauri::command]
pub async fn phone_wait(app: AppHandle, channel: String) -> Result<Value, String> {
    let mut events = app.state::<LocalServer>().0.phone_events();
    let asked = events
        .wait_for(|event| {
            event.as_ref().is_some_and(|event| {
                (event["event"] == "approval" || event["event"] == "expired")
                    && event_channel(event) == Some(channel.as_str())
            })
        })
        .await
        .map_err(|_| "off".to_owned())?;
    Ok(asked.clone().unwrap_or(Value::Null))
}

/// The person allowed the phone: it gets its sign-in, and the window closes.
#[tauri::command]
pub async fn approve_phone(app: AppHandle, channel: String) -> Result<(), String> {
    agent(&app).await?.approve(&channel).await?;
    close(&app);
    Ok(())
}

/// The email of the account signed in to `server` in the main window. The phone gets a session
/// of that account, so the window names it.
async fn account(app: &AppHandle, server: &Url) -> Option<String> {
    let cookies = Window(app.clone()).cookies(server).await?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let session: Value = client
        .get(server.join("/api/auth/get-session").ok()?)
        .header("cookie", cookies)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    session_email(&session)
}

fn session_email(session: &Value) -> Option<String> {
    Some(session.get("user")?.get("email")?.as_str()?.to_owned())
}

/// The QR code of `text` as its width and one `1` (dark) or `0` per module, row by row.
fn qr(text: &str) -> Result<(usize, String), String> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|error| error.to_string())?;
    let cells = code
        .to_colors()
        .iter()
        .map(|color| {
            if *color == qrcode::Color::Dark {
                '1'
            } else {
                '0'
            }
        })
        .collect();
    Ok((code.width(), cells))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_code_is_a_square_of_modules() {
        let (size, cells) = qr("dozo://pair#eyJ2IjoxfQ").unwrap();
        assert_eq!(cells.len(), size * size);
        assert!(cells.chars().all(|cell| cell == '0' || cell == '1'));
        // A finder pattern's top row in the corner.
        assert_eq!(&cells[..7], "1111111");
    }

    #[test]
    fn the_account_is_the_session_s_email() {
        let session = json!({ "session": {}, "user": { "email": "owner@example.test" } });
        assert_eq!(
            session_email(&session).as_deref(),
            Some("owner@example.test")
        );
        assert_eq!(session_email(&Value::Null), None);
    }
}
