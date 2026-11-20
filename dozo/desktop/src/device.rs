//! "Let Bots Use This Computer": the menu switch, the system prompt that grants it and the
//! connection's life. The pairing itself (consent, token, ending it) is `device_pairing.rs`;
//! the connection is `device_socket.rs`. Pairing follows upstream's desktop app
//! (`apps/desktop/src/user-device.ts`).
//!
//! Nothing here is reachable from a page: the switch is a native menu item and the consent a
//! native prompt naming the server. Every change runs one at a time under one lock, and the menu
//! item's check mark is always set from the saved consent, never from the click.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Manager, Url, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::watch;

use crate::device_pairing::{Failure, Keyring, Outcome, Pairing, Secrets, Ui, pending_origins};
use crate::device_run::Runner;
use crate::device_socket::{self, Options, Revoked};

pub const MENU_ID: &str = "device";

/// The words of the switch and its prompts, in English or Turkish like the update item.
pub struct Words {
    pub menu: &'static str,
    title: &'static str,
    warning: &'static str,
    allow: &'static str,
    cancel: &'static str,
    failed: &'static str,
    no_keyring: &'static str,
    unreachable: &'static str,
}

pub fn words(locale: Option<&str>) -> Words {
    if locale.is_some_and(|locale| locale.to_ascii_lowercase().starts_with("tr")) {
        return Words {
            menu: "Botlar Bu Bilgisayarı Kullansın",
            title: "Botlar bu bilgisayarı kullansın mı?",
            warning: "{host} üzerindeki bir bot bu bilgisayarda dosyalarınızı okuyabilir ve sizin adınıza programlar çalıştırabilir.",
            allow: "İzin Ver",
            cancel: "İptal",
            failed: "Bu bilgisayar bağlanamadı.",
            no_keyring: "Bu bilgisayarda eşlemeyi saklayacak bir sistem anahtarlığı yok.",
            unreachable: "Sunucuya ulaşılamadı. Botlar bu bilgisayarı kullanamaz; sunucu geri gelince bu bilgisayar oradan da kaldırılacak.",
        };
    }
    Words {
        menu: "Let Bots Use This Computer",
        title: "Allow bots to use this computer?",
        warning: "A bot on {host} can read your files on this computer and run programs as you.",
        allow: "Allow",
        cancel: "Cancel",
        failed: "Could not connect this computer.",
        no_keyring: "This computer has no system keyring to keep the pairing in.",
        unreachable: "Could not reach the server. Bots cannot use this computer; it is removed from the server once the server is back.",
    }
}

fn local_words() -> Words {
    words(sys_locale::get_locale().as_deref())
}

/// The menu's switch.
pub struct Item(pub CheckMenuItem<Wry>);

pub struct Access {
    runner: Arc<Runner>,
    secrets: Arc<dyn Secrets>,
    /// Held by every change: turning on or off, pairing, the server ending it, revoke retries.
    lock: tokio::sync::Mutex<()>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// The chosen server's origin; `generation` changes with it.
    origin: Option<Url>,
    generation: u64,
    client: Option<watch::Sender<bool>>,
    /// Origins with a revoke retry running.
    retrying: HashSet<String>,
}

impl Access {
    pub fn new(app: &AppHandle) -> tauri::Result<Self> {
        let root = app.path().app_data_dir()?.join("computers");
        let home = app.path().home_dir()?;
        Ok(Self {
            runner: Runner::new(root, home),
            secrets: Arc::new(Keyring),
            lock: tokio::sync::Mutex::new(()),
            state: Mutex::default(),
        })
    }

    /// Stops the connection and every command it started.
    fn disconnect(&self) {
        if let Some(client) = self.state.lock().unwrap().client.take() {
            let _ = client.send(true);
        }
        self.runner.stop_all();
    }

    fn current(&self) -> (u64, Option<Url>) {
        let state = self.state.lock().unwrap();
        (state.generation, state.origin.clone())
    }

    fn connected(&self) -> bool {
        self.state.lock().unwrap().client.is_some()
    }
}

fn devices_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("devices"))
}

fn pairing(app: &AppHandle, origin: &Url) -> Option<Pairing> {
    let secrets = app.state::<Access>().secrets.clone();
    Some(Pairing::new(origin.clone(), devices_dir(app)?, secrets))
}

/// The check mark, from the one source: whether this computer is allowed for the current server.
fn sync_check(app: &AppHandle) {
    let (_, origin) = app.state::<Access>().current();
    let allowed = origin
        .and_then(|origin| pairing(app, &origin))
        .is_some_and(|pairing| pairing.consent().is_some());
    if let Some(item) = app.try_state::<Item>() {
        let _ = item.0.set_checked(allowed);
    }
}

fn spawn(future: impl Future<Output = ()> + Send + 'static) {
    tauri::async_runtime::spawn(future);
}

struct Window(AppHandle);

impl Ui for Window {
    async fn ask(&self, host: &str) -> bool {
        let words = local_words();
        let mut dialog = self
            .0
            .dialog()
            .message(words.warning.replace("{host}", host))
            .title(words.title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                words.allow.to_owned(),
                words.cancel.to_owned(),
            ));
        if let Some(window) = self.0.get_webview_window("main") {
            dialog = dialog.parent(&window);
        }
        tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
            .await
            .unwrap_or(false)
    }

    /// Read off the main thread: on Windows the web view deadlocks otherwise.
    async fn cookies(&self) -> Option<String> {
        let window = self.0.get_webview_window("main")?;
        let (_, origin) = self.0.state::<Access>().current();
        let origin = origin?;
        let cookies = tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(origin))
            .await
            .ok()?
            .ok()?;
        let header = cookies
            .iter()
            .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
            .collect::<Vec<_>>()
            .join("; ");
        (!header.is_empty()).then_some(header)
    }
}

fn tell(app: &AppHandle, failure: &Failure) {
    let words = local_words();
    let message = match failure {
        Failure::Server(Some(reason)) => reason.clone(),
        Failure::Server(None) => words.failed.to_owned(),
        Failure::Keyring => words.no_keyring.to_owned(),
        Failure::RevokePending => words.unreachable.to_owned(),
    };
    app.dialog()
        .message(message)
        .title(words.failed)
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

/// After the server changes (and at launch): connect to the new one if this computer is allowed
/// there. Also retries the revokes left pending, by this run or an earlier one.
pub fn select(app: &AppHandle, server: Option<Url>) {
    let access = app.state::<Access>();
    access.disconnect();
    let origin = server.and_then(|server| Url::parse(&server.origin().ascii_serialization()).ok());
    {
        let mut state = access.state.lock().unwrap();
        state.generation += 1;
        state.origin = origin;
    }
    sync_check(app);
    let app = app.clone();
    spawn(async move {
        if let Some(dir) = devices_dir(&app) {
            for origin in pending_origins(&dir) {
                retry_revoke(&app, origin);
            }
        }
        refresh(&app).await;
    });
}

/// Connects when allowed and paired, or pairs when allowed and signed in.
async fn refresh(app: &AppHandle) {
    let access = app.state::<Access>();
    let _held = access.lock.lock().await;
    let (generation, Some(origin)) = access.current() else {
        return;
    };
    let Some(pairing) = pairing(app, &origin) else {
        return;
    };
    if access.connected() || pairing.consent().is_none() {
        return;
    }
    match pairing.pair(&Window(app.clone())).await {
        Ok(Outcome::Connected(token)) => start(app, generation, &pairing, token),
        Err(Failure::RevokePending) => retry_revoke(app, origin),
        _ => {}
    }
    sync_check(app);
}

/// The menu switch was clicked. The saved consent decides; the mark follows it afterwards.
pub fn clicked(app: &AppHandle) {
    let app = app.clone();
    spawn(async move {
        let access = app.state::<Access>();
        let _held = access.lock.lock().await;
        let (generation, origin) = access.current();
        let Some(pairing) = origin.as_ref().and_then(|origin| pairing(&app, origin)) else {
            return sync_check(&app);
        };
        if pairing.consent().is_some() {
            access.disconnect();
            if pairing.turn_off().await.is_err() {
                tell(&app, &Failure::RevokePending);
                retry_revoke(&app, pairing.origin().clone());
            }
        } else {
            match pairing.turn_on(&Window(app.clone())).await {
                Ok(Outcome::Connected(token)) => start(&app, generation, &pairing, token),
                Ok(_) => {}
                Err(failure) => {
                    if failure == Failure::RevokePending {
                        retry_revoke(&app, pairing.origin().clone());
                    }
                    tell(&app, &failure);
                }
            }
        }
        sync_check(&app);
    });
}

/// A page of the server loaded or the window came forward: pair if allowed and not paired yet,
/// as after signing in again. Skipped while another change runs.
pub fn wake(app: &AppHandle) {
    let access = app.state::<Access>();
    if access.connected() || access.lock.try_lock().is_err() {
        return;
    }
    let app = app.clone();
    spawn(async move { refresh(&app).await });
}

/// Stops every command before the app quits.
pub fn quit(app: &AppHandle) {
    if let Some(access) = app.try_state::<Access>() {
        access.disconnect();
    }
}

/// Ends a pending revoke once the server is back: soon, then less and less often, for as long
/// as the app runs. The next launch and turning it on again try too.
fn retry_revoke(app: &AppHandle, origin: Url) {
    let access = app.state::<Access>();
    if !access
        .state
        .lock()
        .unwrap()
        .retrying
        .insert(origin.to_string())
    {
        return;
    }
    let app = app.clone();
    spawn(async move {
        let mut delay = Duration::from_secs(5);
        loop {
            tokio::time::sleep(delay).await;
            let access = app.state::<Access>();
            let _held = access.lock.lock().await;
            let done = match pairing(&app, &origin) {
                Some(pairing) => pairing.finish_revoke().await,
                None => true,
            };
            if done {
                break;
            }
            delay = (delay * 2).min(Duration::from_secs(300));
        }
        let access = app.state::<Access>();
        access
            .state
            .lock()
            .unwrap()
            .retrying
            .remove(origin.as_str());
    });
}

/// Connects. Called with the lock held, right after the pairing confirmed consent and token.
fn start(app: &AppHandle, generation: u64, pairing: &Pairing, token: String) {
    let access = app.state::<Access>();
    let (stop, stopped) = watch::channel(false);
    {
        let mut state = access.state.lock().unwrap();
        if state.generation != generation || state.origin.as_ref() != Some(pairing.origin()) {
            return;
        }
        if let Some(previous) = state.client.replace(stop) {
            let _ = previous.send(true);
        }
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let origin = pairing.origin().clone();
    let options = Options {
        server: origin.clone(),
        token,
        runner: access.runner.clone(),
        retry: (Duration::from_secs(1), Duration::from_secs(60)),
    };
    let app = app.clone();
    spawn(async move {
        let Some(revoked) = device_socket::run(options, stopped).await else {
            return;
        };
        ended(&app, generation, origin, revoked).await;
    });
}

/// The server ended the pairing.
async fn ended(app: &AppHandle, generation: u64, origin: Url, revoked: Revoked) {
    let access = app.state::<Access>();
    let _held = access.lock.lock().await;
    {
        let mut state = access.state.lock().unwrap();
        if state.generation == generation {
            state.client = None;
        }
    }
    if let Some(pairing) = pairing(app, &origin) {
        pairing
            .ended(revoked.as_deref() == Some("session-ended"))
            .await;
    }
    sync_check(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_words_follow_the_system_language_and_name_the_server() {
        assert_eq!(words(Some("tr-TR")).menu, "Botlar Bu Bilgisayarı Kullansın");
        assert_eq!(words(Some("en-US")).menu, "Let Bots Use This Computer");
        assert_eq!(words(None).allow, "Allow");
        for locale in [Some("tr"), None] {
            assert!(words(locale).warning.contains("{host}"));
        }
    }
}
