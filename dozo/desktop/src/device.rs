//! "Let Bots Use This Computer": the menu switch, the system prompt that grants it, pairing with
//! the chosen server and the connection's life. Pairing follows upstream's desktop app
//! (`apps/desktop/src/user-device.ts`): the app posts the person's sign-in to
//! `/api/devices/pair` and keeps the device token it gets back; the server only ever reaches this
//! computer through the connection the app opens (`device_socket.rs`).
//!
//! Nothing here is reachable from a page: the switch is a native menu item and the consent a
//! native prompt. The answer holds for one server and one account. Turning it off, removing the
//! computer in the web app's settings, or the server ending the pairing stops every command.
//! A sign-out or password reset ends the pairing; the same account's next sign-in pairs again,
//! another account's asks again.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Manager, Url, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::watch;

use crate::device_run::Runner;
use crate::device_socket::{self, Options, Revoked};

pub const MENU_ID: &str = "device";
const PAIR_PATH: &str = "/api/devices/pair";
const SELF_PATH: &str = "/api/devices/self";
const MAX_TOKEN: usize = 1024;

/// The words of the switch and its prompt, in English or Turkish like the update item.
pub struct Words {
    pub menu: &'static str,
    title: &'static str,
    warning: &'static str,
    allow: &'static str,
    cancel: &'static str,
    failed: &'static str,
}

pub fn words(locale: Option<&str>) -> Words {
    if locale.is_some_and(|locale| locale.to_ascii_lowercase().starts_with("tr")) {
        return Words {
            menu: "Botlar Bu Bilgisayarı Kullansın",
            title: "Botlar bu bilgisayarı kullansın mı?",
            warning: "Bir bot bu bilgisayarda dosyalarınızı okuyabilir ve sizin adınıza programlar çalıştırabilir.",
            allow: "İzin Ver",
            cancel: "İptal",
            failed: "Bu bilgisayar bağlanamadı.",
        };
    }
    Words {
        menu: "Let Bots Use This Computer",
        title: "Allow bots to use this computer?",
        warning: "A bot can read your files on this computer and run programs as you.",
        allow: "Allow",
        cancel: "Cancel",
        failed: "Could not connect this computer.",
    }
}

fn local_words() -> Words {
    words(sys_locale::get_locale().as_deref())
}

/// The menu's switch.
pub struct Item(pub CheckMenuItem<Wry>);

pub struct Access {
    runner: Arc<Runner>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// The chosen server's origin; bumping `generation` drops answers meant for an earlier one.
    origin: Option<Url>,
    generation: u64,
    client: Option<watch::Sender<bool>>,
    /// A prompt or a pairing is under way.
    busy: bool,
}

impl Access {
    pub fn new(app: &AppHandle) -> tauri::Result<Self> {
        let root = app.path().app_data_dir()?.join("computers");
        let home = app.path().home_dir()?;
        Ok(Self {
            runner: Runner::new(root, home),
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

    fn current(&self, generation: u64) -> Option<Url> {
        let state = self.state.lock().unwrap();
        (state.generation == generation)
            .then(|| state.origin.clone())
            .flatten()
    }
}

/// A pairing: the token the server gave this computer and the account it was given for.
#[derive(Debug, PartialEq)]
struct Pairing {
    token: String,
    device: String,
    user: String,
}

fn devices_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("devices"))
}

fn file(dir: &Path, origin: &Url, suffix: &str) -> PathBuf {
    let key: String = Sha256::digest(origin.as_str().as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    dir.join(format!("{key}{suffix}.json"))
}

/// Readable by this user only: the token lets its holder answer for this computer.
fn write_private(path: &Path, body: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(path);
    std::fs::create_dir_all(dir)?;
    let partial = path.with_extension("partial");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        options.mode(0o600);
    }
    options.open(&partial)?.write_all(body.as_bytes())?;
    std::fs::rename(partial, path)
}

fn read_json(path: &Path, origin: &Url) -> Option<Value> {
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    (saved.get("origin")?.as_str()? == origin.as_str()).then_some(saved)
}

fn read_pairing(dir: &Path, origin: &Url) -> Option<Pairing> {
    let saved = read_json(&file(dir, origin, ""), origin)?;
    let text = |key: &str| Some(saved.get(key)?.as_str()?.to_owned());
    let token = text("token").filter(|token| !token.is_empty() && token.len() <= MAX_TOKEN)?;
    Some(Pairing {
        token,
        device: text("deviceId")?,
        user: text("userId")?,
    })
}

fn save_pairing(dir: &Path, origin: &Url, pairing: &Pairing) -> std::io::Result<()> {
    let body = json!({ "origin": origin.as_str(), "token": pairing.token,
        "deviceId": pairing.device, "userId": pairing.user });
    write_private(&file(dir, origin, ""), &body.to_string())
}

/// The account the person allowed this computer for; `Some(None)` before the first pairing
/// names it.
fn read_consent(dir: &Path, origin: &Url) -> Option<Option<String>> {
    let saved = read_json(&file(dir, origin, ".consent"), origin)?;
    Some(saved.get("userId")?.as_str().map(str::to_owned))
}

fn save_consent(dir: &Path, origin: &Url, user: Option<&str>) -> std::io::Result<()> {
    let body = json!({ "origin": origin.as_str(), "userId": user });
    write_private(&file(dir, origin, ".consent"), &body.to_string())
}

fn forget(dir: &Path, origin: &Url, consent_too: bool) {
    let _ = std::fs::remove_file(file(dir, origin, ""));
    if consent_too {
        let _ = std::fs::remove_file(file(dir, origin, ".consent"));
    }
}

/// Whether a pairing may serve the consent given.
fn consented(consent: &Option<String>, pairing: &Pairing) -> bool {
    consent.as_deref().is_none_or(|user| user == pairing.user)
}

fn set_checked(app: &AppHandle, checked: bool) {
    if let Some(item) = app.try_state::<Item>() {
        let _ = item.0.set_checked(checked);
    }
}

fn spawn(future: impl Future<Output = ()> + Send + 'static) {
    tauri::async_runtime::spawn(future);
}

/// After the server changes (and at launch): connect to the new one if this computer is allowed
/// there.
pub fn select(app: &AppHandle, server: Option<Url>) {
    let access = app.state::<Access>();
    access.disconnect();
    let origin = server.map(|server| server.origin().ascii_serialization());
    let origin = origin.and_then(|origin| Url::parse(&origin).ok());
    let generation = {
        let mut state = access.state.lock().unwrap();
        state.generation += 1;
        state.origin = origin.clone();
        state.busy = false;
        state.generation
    };
    let (Some(origin), Some(dir)) = (origin, devices_dir(app)) else {
        return set_checked(app, false);
    };
    let consent = read_consent(&dir, &origin);
    set_checked(app, consent.is_some());
    let Some(consent) = consent else { return };
    match read_pairing(&dir, &origin) {
        Some(pairing) if consented(&consent, &pairing) => start(app, generation, pairing.token),
        _ => wake(app),
    }
}

/// The menu switch was clicked. The item already shows the new state; the saved answer decides.
pub fn clicked(app: &AppHandle) {
    let app = app.clone();
    spawn(async move {
        let access = app.state::<Access>();
        let (generation, origin) = {
            let state = access.state.lock().unwrap();
            (state.generation, state.origin.clone())
        };
        let (Some(origin), Some(dir)) = (origin, devices_dir(&app)) else {
            return set_checked(&app, false);
        };
        if read_consent(&dir, &origin).is_some() {
            turn_off(&app, &dir, &origin).await;
        } else {
            turn_on(&app, generation, &dir, &origin).await;
        }
    });
}

/// A page of the server loaded or the window came forward: pair if allowed and not paired yet,
/// as after signing in again.
pub fn wake(app: &AppHandle) {
    let app = app.clone();
    spawn(async move {
        let access = app.state::<Access>();
        let (generation, origin, connected) = {
            let state = access.state.lock().unwrap();
            (
                state.generation,
                state.origin.clone(),
                state.client.is_some() || state.busy,
            )
        };
        let (Some(origin), Some(dir)) = (origin, devices_dir(&app)) else {
            return;
        };
        if connected || read_consent(&dir, &origin).is_none() {
            return;
        }
        pair(&app, generation, &dir, &origin, false).await;
    });
}

/// Stops every command before the app quits.
pub fn quit(app: &AppHandle) {
    if let Some(access) = app.try_state::<Access>() {
        access.disconnect();
    }
}

fn claim(app: &AppHandle, generation: u64) -> bool {
    let access = app.state::<Access>();
    let mut state = access.state.lock().unwrap();
    if state.busy || state.generation != generation {
        return false;
    }
    state.busy = true;
    true
}

fn release(app: &AppHandle, generation: u64) {
    let access = app.state::<Access>();
    let mut state = access.state.lock().unwrap();
    if state.generation == generation {
        state.busy = false;
    }
}

async fn turn_on(app: &AppHandle, generation: u64, dir: &Path, origin: &Url) {
    set_checked(app, false);
    if !claim(app, generation) {
        return;
    }
    if ask(app).await && save_consent(dir, origin, None).is_ok() {
        set_checked(app, true);
        release(app, generation);
        pair(app, generation, dir, origin, true).await;
    } else {
        release(app, generation);
    }
}

async fn turn_off(app: &AppHandle, dir: &Path, origin: &Url) {
    app.state::<Access>().disconnect();
    let pairing = read_pairing(dir, origin);
    forget(dir, origin, true);
    set_checked(app, false);
    if let Some(pairing) = pairing {
        revoke(origin, &pairing.token).await;
    }
}

/// Pairs with the server under the person's sign-in, then connects. Signed out, it waits for
/// the next page load or focus. `interactive`: the person just turned it on, so a refusal is
/// shown and turns it off again.
async fn pair(app: &AppHandle, generation: u64, dir: &Path, origin: &Url, interactive: bool) {
    if !claim(app, generation) {
        return;
    }
    let outcome = pair_once(app, generation, dir, origin).await;
    release(app, generation);
    match outcome {
        Paired::Connected(token) => start(app, generation, token),
        Paired::SignedOut | Paired::Superseded => {}
        Paired::Declined => {
            forget(dir, origin, true);
            set_checked(app, false);
        }
        Paired::Failed(reason) => {
            if interactive {
                forget(dir, origin, true);
                set_checked(app, false);
                let words = local_words();
                let message = reason.unwrap_or_else(|| words.failed.to_owned());
                app.dialog()
                    .message(message)
                    .title(words.failed)
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    }
}

enum Paired {
    Connected(String),
    SignedOut,
    /// Another server was chosen or the switch turned off meanwhile.
    Superseded,
    Declined,
    /// The server's own sentence, when it gave one.
    Failed(Option<String>),
}

async fn pair_once(app: &AppHandle, generation: u64, dir: &Path, origin: &Url) -> Paired {
    let Some(consent) = read_consent(dir, origin) else {
        return Paired::Superseded;
    };
    if let Some(pairing) = read_pairing(dir, origin)
        && consented(&consent, &pairing)
    {
        return Paired::Connected(pairing.token);
    }
    let Some(cookies) = cookies(app, origin).await else {
        return Paired::SignedOut;
    };
    let pairing = match request_pairing(origin, &cookies).await {
        Ok(pairing) => pairing,
        Err(outcome) => return outcome,
    };
    let still =
        |app: &AppHandle| app.state::<Access>().current(generation).as_ref() == Some(origin);
    let mut keep = still(app) && read_consent(dir, origin).is_some();
    // Another account signed in since the person allowed it: theirs is asked for again.
    if keep && !consented(&consent, &pairing) {
        keep = ask(app).await && still(app);
        if !keep {
            revoke(origin, &pairing.token).await;
            return Paired::Declined;
        }
    }
    if !keep {
        revoke(origin, &pairing.token).await;
        return Paired::Superseded;
    }
    if save_pairing(dir, origin, &pairing).is_err()
        || save_consent(dir, origin, Some(&pairing.user)).is_err()
    {
        // A token that cannot be kept must not stay valid on the server.
        revoke(origin, &pairing.token).await;
        return Paired::Failed(None);
    }
    Paired::Connected(pairing.token)
}

/// The web view's cookies for the server, as a `Cookie` header; `None` when it holds none.
/// Read off the main thread: on Windows the web view deadlocks otherwise.
async fn cookies(app: &AppHandle, origin: &Url) -> Option<String> {
    let window = app.get_webview_window("main")?;
    let origin = origin.clone();
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

fn client() -> Option<reqwest::Client> {
    // The same TLS the update check sets up: ring, under the system's trusted roots.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .ok()
}

async fn request_pairing(origin: &Url, cookies: &str) -> Result<Pairing, Paired> {
    let client = client().ok_or(Paired::Failed(None))?;
    let url = origin.join(PAIR_PATH).map_err(|_| Paired::Failed(None))?;
    let body = json!({ "name": device_name(), "platform": platform() });
    let response = client
        .post(url)
        .header("content-type", "application/json")
        .header("cookie", cookies)
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| Paired::Failed(None))?;
    let status = response.status();
    let answer: Value = response
        .bytes()
        .await
        .ok()
        .and_then(|body| serde_json::from_slice(&body).ok())
        .unwrap_or(Value::Null);
    if status == 401 {
        return Err(Paired::SignedOut);
    }
    if !status.is_success() {
        let sentence = answer.get("error").and_then(Value::as_str);
        return Err(Paired::Failed(sentence.map(str::to_owned)));
    }
    let text = |key: &str| answer.get(key).and_then(Value::as_str).map(str::to_owned);
    match (text("token"), text("deviceId"), text("userId")) {
        (Some(token), Some(device), Some(user))
            if !token.is_empty() && token.len() <= MAX_TOKEN =>
        {
            Ok(Pairing {
                token,
                device,
                user,
            })
        }
        _ => Err(Paired::Failed(None)),
    }
}

/// Ends a pairing on the server. Best effort: the local token is deleted either way.
async fn revoke(origin: &Url, token: &str) {
    let (Some(client), Ok(url)) = (client(), origin.join(SELF_PATH)) else {
        return;
    };
    let _ = client.delete(url).bearer_auth(token).send().await;
}

fn start(app: &AppHandle, generation: u64, token: String) {
    let access = app.state::<Access>();
    let (stop, stopped) = watch::channel(false);
    let origin = {
        let mut state = access.state.lock().unwrap();
        let Some(origin) = state
            .origin
            .clone()
            .filter(|_| state.generation == generation)
        else {
            return;
        };
        if let Some(previous) = state.client.replace(stop) {
            let _ = previous.send(true);
        }
        origin
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
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
        ended(&app, generation, &origin, revoked);
    });
}

/// The server ended the pairing. A sign-out keeps the answer for that account's next sign-in;
/// anything else (removed in settings, token refused) turns the switch off.
fn ended(app: &AppHandle, generation: u64, origin: &Url, revoked: Revoked) {
    let Some(dir) = devices_dir(app) else { return };
    let access = app.state::<Access>();
    {
        let mut state = access.state.lock().unwrap();
        if state.generation == generation {
            state.client = None;
        }
    }
    let signed_out = revoked.as_deref() == Some("session-ended");
    forget(&dir, origin, !signed_out);
    if access.current(generation).as_ref() != Some(origin) {
        return;
    }
    if signed_out {
        wake(app);
    } else {
        set_checked(app, false);
    }
}

/// The system prompt. True only when the person picks Allow.
async fn ask(app: &AppHandle) -> bool {
    let words = local_words();
    let mut dialog = app
        .dialog()
        .message(words.warning)
        .title(words.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            words.allow.to_owned(),
            words.cancel.to_owned(),
        ));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .unwrap_or(false)
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        _ => "linux",
    }
}

/// The name the web app lists this computer under.
fn device_name() -> String {
    let name = system_name().unwrap_or_default();
    let name = name.trim().trim_end_matches(".local");
    let name = if name.is_empty() { "Computer" } else { name };
    name.chars().take(128).collect()
}

#[cfg(target_os = "macos")]
fn system_name() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()?;
    String::from_utf8(output.stdout)
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(host_name)
}

#[cfg(target_os = "linux")]
fn system_name() -> Option<String> {
    host_name()
}

#[cfg(unix)]
fn host_name() -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer outlives the call and its length is passed with it.
    let failed = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } != 0;
    let end = buffer.iter().position(|byte| *byte == 0)?;
    (!failed).then(|| String::from_utf8_lossy(&buffer[..end]).into_owned())
}

#[cfg(windows)]
fn system_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dozo-device-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn origin(address: &str) -> Url {
        Url::parse(address).unwrap()
    }

    #[test]
    fn a_pairing_is_kept_per_server_and_readable_by_its_user_only() {
        let dir = dir();
        let server = origin("https://dozo.example");
        let pairing = Pairing {
            token: "t".into(),
            device: "d".into(),
            user: "u".into(),
        };
        save_pairing(&dir, &server, &pairing).unwrap();
        assert_eq!(read_pairing(&dir, &server), Some(pairing));
        assert_eq!(read_pairing(&dir, &origin("https://other.example")), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(file(&dir, &server, ""))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        forget(&dir, &server, false);
        assert_eq!(read_pairing(&dir, &server), None);
    }

    #[test]
    fn consent_belongs_to_the_account_it_was_given_for() {
        let dir = dir();
        let server = origin("https://dozo.example");
        assert_eq!(read_consent(&dir, &server), None);
        save_consent(&dir, &server, None).unwrap();
        assert_eq!(read_consent(&dir, &server), Some(None));
        let pairing = |user: &str| Pairing {
            token: "t".into(),
            device: "d".into(),
            user: user.into(),
        };
        assert!(consented(&None, &pairing("a")));
        save_consent(&dir, &server, Some("a")).unwrap();
        let consent = read_consent(&dir, &server).unwrap();
        assert!(consented(&consent, &pairing("a")));
        assert!(!consented(&consent, &pairing("b")));
        forget(&dir, &server, true);
        assert_eq!(read_consent(&dir, &server), None);
    }

    #[test]
    fn the_words_follow_the_system_language() {
        assert_eq!(words(Some("tr-TR")).menu, "Botlar Bu Bilgisayarı Kullansın");
        assert_eq!(words(Some("en-US")).menu, "Let Bots Use This Computer");
        assert_eq!(words(None).allow, "Allow");
    }

    #[test]
    fn the_device_names_itself() {
        let name = device_name();
        assert!(!name.is_empty() && name.chars().count() <= 128);
        assert!(["darwin", "win32", "linux"].contains(&platform()));
    }
}
