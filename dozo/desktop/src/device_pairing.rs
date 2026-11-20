//! This computer's pairing with one server, apart from the window: the consent the person gave,
//! the device token the server issued, and ending it. The token lives in the system's keyring
//! (macOS Keychain, Windows Credential Manager, the Secret Service on Linux); without one the
//! computer does not pair, as upstream's app refuses to without secure storage. The folder keeps
//! only what is not secret: which account the consent and the pairing are for, and whether the
//! pairing still has to be ended on the server.
//!
//! A pairing turned off while the server cannot be reached stays "revoking": no command reaches
//! this computer, the token stays in the keyring, and every later attempt (a retry, the next
//! launch, turning it on again) first ends it on the server. A new pairing never starts while an
//! old one may still be valid there.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::Url;

const PAIR_PATH: &str = "/api/devices/pair";
const SELF_PATH: &str = "/api/devices/self";
const MAX_TOKEN: usize = 1024;
/// The keyring entry used to check that a keyring is there before pairing.
const PROBE: &str = "probe";

/// The system keyring, or a stand-in in tests. Calls may block: run them off async threads.
pub trait Secrets: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

pub struct Keyring;

const SERVICE: &str = "dev.ssilistre.dozo";

impl Secrets for Keyring {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        entry.set_password(secret).map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// What the pairing needs from the window: the person's answer and the sign-in.
pub trait Ui: Send + Sync {
    /// The system consent prompt naming the server. True only when the person picks Allow.
    fn ask(&self, host: &str) -> impl Future<Output = bool> + Send;
    /// The web view's cookies for the server as a `Cookie` header; `None` when signed out.
    fn cookies(&self) -> impl Future<Output = Option<String>> + Send;
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Paired for the allowed account: connect with this token.
    Connected(String),
    /// Allowed, but nobody is signed in: pairs on a later page load or focus.
    SignedOut,
    /// The person said no, or turned it off meanwhile.
    Declined,
}

#[derive(Debug, PartialEq)]
pub enum Failure {
    /// The server refused, with its own sentence when it gave one, or could not be reached.
    Server(Option<String>),
    /// No system keyring to keep the token in.
    Keyring,
    /// An earlier pairing could not be ended on the server yet.
    RevokePending,
}

/// The saved, non-secret half of a pairing.
#[derive(Debug, PartialEq, Clone)]
struct Saved {
    device: String,
    user: String,
    revoking: bool,
}

pub struct Pairing {
    origin: Url,
    dir: PathBuf,
    secrets: Arc<dyn Secrets>,
}

impl Pairing {
    pub fn new(origin: Url, dir: PathBuf, secrets: Arc<dyn Secrets>) -> Self {
        Self {
            origin,
            dir,
            secrets,
        }
    }

    pub fn origin(&self) -> &Url {
        &self.origin
    }

    fn file(&self, suffix: &str) -> PathBuf {
        file(&self.dir, &self.origin, suffix)
    }

    /// The account the person allowed this computer for; `Some(None)` before the first pairing
    /// names it, `None` when not allowed.
    pub fn consent(&self) -> Option<Option<String>> {
        let saved = read_json(&self.file(".consent"), &self.origin)?;
        Some(saved.get("userId")?.as_str().map(str::to_owned))
    }

    fn save_consent(&self, user: Option<&str>) -> std::io::Result<()> {
        let body = json!({ "origin": self.origin.as_str(), "userId": user });
        write_private(&self.file(".consent"), &body.to_string())
    }

    fn remove_consent(&self) {
        let _ = std::fs::remove_file(self.file(".consent"));
    }

    fn saved(&self) -> Option<Saved> {
        let saved = read_json(&self.file(""), &self.origin)?;
        let text = |key: &str| Some(saved.get(key)?.as_str()?.to_owned());
        Some(Saved {
            device: text("deviceId")?,
            user: text("userId")?,
            revoking: saved.get("revoking").and_then(Value::as_bool) == Some(true),
        })
    }

    fn save(&self, saved: &Saved) -> std::io::Result<()> {
        let body = json!({ "origin": self.origin.as_str(), "deviceId": saved.device,
            "userId": saved.user, "revoking": saved.revoking });
        write_private(&self.file(""), &body.to_string())
    }

    async fn secret(&self, op: Secret) -> Result<Option<String>, String> {
        let secrets = self.secrets.clone();
        let account = self.origin.as_str().to_owned();
        tokio::task::spawn_blocking(move || match op {
            Secret::Get => secrets.get(&account),
            Secret::Set(token) => secrets.set(&account, &token).map(|()| None),
            Secret::Delete => secrets.delete(&account).map(|()| None),
            Secret::Probe => secrets
                .set(PROBE, "1")
                .and_then(|()| secrets.delete(PROBE))
                .map(|()| None),
        })
        .await
        .map_err(|error| error.to_string())?
    }

    /// Forgets the pairing here, token and all.
    async fn forget(&self) {
        let _ = self.secret(Secret::Delete).await;
        let _ = std::fs::remove_file(self.file(""));
    }

    pub fn revoke_pending(&self) -> bool {
        self.saved().is_some_and(|saved| saved.revoking)
    }

    /// The token to connect with: allowed, paired for that account, nothing being revoked.
    pub async fn token(&self) -> Option<String> {
        let consent = self.consent()?;
        let saved = self.saved().filter(|saved| !saved.revoking)?;
        if consent.as_deref().is_some_and(|user| user != saved.user) {
            return None;
        }
        self.secret(Secret::Get).await.ok().flatten()
    }

    /// Asks, then pairs. Ends a pairing still being revoked first.
    pub async fn turn_on(&self, ui: &impl Ui) -> Result<Outcome, Failure> {
        if !self.finish_revoke().await {
            return Err(Failure::RevokePending);
        }
        if !ui.ask(&self.host()).await {
            return Ok(Outcome::Declined);
        }
        self.save_consent(None).map_err(|_| Failure::Keyring)?;
        let outcome = self.pair(ui).await;
        if matches!(outcome, Err(Failure::Server(_) | Failure::Keyring)) {
            self.remove_consent();
        }
        outcome
    }

    /// Pairs under the person's sign-in when allowed and not paired yet.
    pub async fn pair(&self, ui: &impl Ui) -> Result<Outcome, Failure> {
        let Some(consent) = self.consent() else {
            return Ok(Outcome::Declined);
        };
        if !self.finish_revoke().await {
            return Err(Failure::RevokePending);
        }
        if let Some(token) = self.token().await {
            return Ok(Outcome::Connected(token));
        }
        if self.secret(Secret::Probe).await.is_err() {
            return Err(Failure::Keyring);
        }
        let Some(cookies) = ui.cookies().await else {
            return Ok(Outcome::SignedOut);
        };
        let (token, saved) = match request_pairing(&self.origin, &cookies).await {
            Ok(paired) => paired,
            Err(None) => return Ok(Outcome::SignedOut),
            Err(Some(failure)) => return Err(failure),
        };
        // Turned off while the server answered.
        let Some(_) = self.consent() else {
            self.end(&token, &saved).await;
            return Ok(Outcome::Declined);
        };
        // Another account signed in since the person allowed it: theirs is asked for again.
        if consent.as_deref().is_some_and(|user| user != saved.user)
            && (!ui.ask(&self.host()).await || self.consent().is_none())
        {
            self.remove_consent();
            self.end(&token, &saved).await;
            return Ok(Outcome::Declined);
        }
        if self.secret(Secret::Set(token.clone())).await.is_err() || self.save(&saved).is_err() {
            self.end(&token, &saved).await;
            return Err(Failure::Keyring);
        }
        if self.save_consent(Some(&saved.user)).is_err() {
            self.turn_off().await.ok();
            return Err(Failure::Keyring);
        }
        Ok(Outcome::Connected(token))
    }

    /// Ends a pairing nobody keeps: on the server now, or as a pending revoke when it cannot
    /// be reached, so the token never stays valid there unnoticed.
    async fn end(&self, token: &str, saved: &Saved) {
        if revoke(&self.origin, token).await {
            return;
        }
        let pending = Saved {
            revoking: true,
            ..saved.clone()
        };
        if self.secret(Secret::Set(token.to_owned())).await.is_ok() {
            let _ = self.save(&pending);
        }
    }

    /// Turns it off: no consent, and the pairing ended on the server. `Err` when the server
    /// could not be reached; the revoke then stays pending.
    pub async fn turn_off(&self) -> Result<(), Failure> {
        self.remove_consent();
        if let Some(saved) = self.saved() {
            let _ = self.save(&Saved {
                revoking: true,
                ..saved
            });
        }
        if self.finish_revoke().await {
            Ok(())
        } else {
            Err(Failure::RevokePending)
        }
    }

    /// Tries to end a pending revoke; true when nothing is pending any more.
    pub async fn finish_revoke(&self) -> bool {
        if !self.revoke_pending() {
            return true;
        }
        match self.secret(Secret::Get).await {
            Ok(Some(token)) if !revoke(&self.origin, &token).await => false,
            Ok(_) => {
                self.forget().await;
                true
            }
            Err(_) => false,
        }
    }

    /// The server ended the pairing. A sign-out keeps the consent for that account's next
    /// sign-in; anything else (removed in settings, token refused) ends it too.
    pub async fn ended(&self, signed_out: bool) {
        self.forget().await;
        if !signed_out {
            self.remove_consent();
        }
    }

    pub fn host(&self) -> String {
        self.origin.host_str().unwrap_or_default().to_owned()
    }
}

enum Secret {
    Get,
    Set(String),
    Delete,
    Probe,
}

/// Every origin with a revoke still pending, for retrying after a launch.
pub fn pending_origins(dir: &Path) -> Vec<Url> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?;
            if !name.ends_with(".json") || name.ends_with(".consent.json") {
                return None;
            }
            let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
            if saved.get("revoking").and_then(Value::as_bool) != Some(true) {
                return None;
            }
            let origin = Url::parse(saved.get("origin")?.as_str()?).ok()?;
            (file(dir, &origin, "") == path).then_some(origin)
        })
        .collect()
}

fn file(dir: &Path, origin: &Url, suffix: &str) -> PathBuf {
    let key: String = Sha256::digest(origin.as_str().as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    dir.join(format!("{key}{suffix}.json"))
}

fn write_private(path: &Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;
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

fn client() -> Option<reqwest::Client> {
    // The same TLS the update check sets up: ring, under the system's trusted roots.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .ok()
}

/// The new token and pairing; `Err(None)` when signed out.
async fn request_pairing(origin: &Url, cookies: &str) -> Result<(String, Saved), Option<Failure>> {
    let failed = || Some(Failure::Server(None));
    let client = client().ok_or_else(failed)?;
    let url = origin.join(PAIR_PATH).map_err(|_| failed())?;
    let body = json!({ "name": device_name(), "platform": platform() });
    let response = client
        .post(url)
        .header("content-type", "application/json")
        .header("cookie", cookies)
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| failed())?;
    let status = response.status();
    let answer: Value = response
        .bytes()
        .await
        .ok()
        .and_then(|body| serde_json::from_slice(&body).ok())
        .unwrap_or(Value::Null);
    if status == 401 {
        return Err(None);
    }
    if !status.is_success() {
        let sentence = answer.get("error").and_then(Value::as_str);
        return Err(Some(Failure::Server(sentence.map(str::to_owned))));
    }
    let text = |key: &str| answer.get(key).and_then(Value::as_str).map(str::to_owned);
    match (text("token"), text("deviceId"), text("userId")) {
        (Some(token), Some(device), Some(user))
            if !token.is_empty() && token.len() <= MAX_TOKEN =>
        {
            Ok((
                token,
                Saved {
                    device,
                    user,
                    revoking: false,
                },
            ))
        }
        _ => Err(failed()),
    }
}

/// Ends a pairing on the server; true once it no longer holds there (also when the server
/// already dropped it).
async fn revoke(origin: &Url, token: &str) -> bool {
    let (Some(client), Ok(url)) = (client(), origin.join(SELF_PATH)) else {
        return false;
    };
    match client.delete(url).bearer_auth(token).send().await {
        Ok(response) => response.status().is_success() || response.status() == 401,
        Err(_) => false,
    }
}

pub fn platform() -> &'static str {
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
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct Memory {
        secrets: Mutex<HashMap<String, String>>,
        broken: AtomicBool,
    }

    impl Secrets for Memory {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.secrets.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            if self.broken.load(Ordering::SeqCst) {
                return Err("no keyring".into());
            }
            self.secrets
                .lock()
                .unwrap()
                .insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.secrets.lock().unwrap().remove(account);
            Ok(())
        }
    }

    /// A fake server: pairs whoever sends a cookie as `user`, issuing tokens t1, t2...;
    /// records revoked tokens; `down` answers 503 to everything.
    #[derive(Default)]
    struct Server {
        user: Mutex<String>,
        issued: AtomicUsize,
        revoked: Mutex<Vec<String>>,
        down: AtomicBool,
    }

    async fn serve(server: Arc<Server>) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let server = server.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    loop {
                        let read = stream.read(&mut buffer).await.unwrap_or(0);
                        request.extend_from_slice(&buffer[..read]);
                        let text = String::from_utf8_lossy(&request);
                        if read == 0
                            || text.find("\r\n\r\n").is_some_and(|head| {
                                let length = text[..head]
                                    .lines()
                                    .find_map(|l| {
                                        l.to_ascii_lowercase()
                                            .strip_prefix("content-length:")
                                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                                    })
                                    .unwrap_or(0);
                                request.len() >= head + 4 + length
                            })
                        {
                            break;
                        }
                    }
                    let text = String::from_utf8_lossy(&request).into_owned();
                    let header = |name: &str| {
                        text.lines().find_map(|l| {
                            l.to_ascii_lowercase()
                                .starts_with(name)
                                .then(|| l[name.len()..].trim().to_owned())
                        })
                    };
                    let (status, body) = if server.down.load(Ordering::SeqCst) {
                        (503, String::new())
                    } else if text.starts_with("POST /api/devices/pair") {
                        if header("cookie:").is_none() {
                            (401, String::new())
                        } else {
                            let n = server.issued.fetch_add(1, Ordering::SeqCst) + 1;
                            let user = server.user.lock().unwrap().clone();
                            (201, json!({ "deviceId": format!("d{n}"), "userId": user, "token": format!("t{n}") }).to_string())
                        }
                    } else if text.starts_with("DELETE /api/devices/self") {
                        let token = header("authorization:")
                            .unwrap_or_default()
                            .replace("Bearer ", "");
                        server.revoked.lock().unwrap().push(token);
                        (204, String::new())
                    } else {
                        (404, String::new())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(reply.as_bytes()).await;
                });
            }
        });
        url
    }

    /// Answers the prompt from a queue (no when empty) and holds the sign-in; `on_cookies` runs
    /// while the pairing request is about to go out.
    #[derive(Default)]
    struct FakeUi {
        answers: Mutex<Vec<bool>>,
        asked: Mutex<Vec<String>>,
        signed_in: AtomicBool,
        on_cookies: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    impl Ui for FakeUi {
        async fn ask(&self, host: &str) -> bool {
            self.asked.lock().unwrap().push(host.to_owned());
            let mut answers = self.answers.lock().unwrap();
            !answers.is_empty() && answers.remove(0)
        }
        async fn cookies(&self) -> Option<String> {
            if let Some(hook) = self.on_cookies.lock().unwrap().take() {
                hook();
            }
            self.signed_in
                .load(Ordering::SeqCst)
                .then(|| "session=s".to_owned())
        }
    }

    struct World {
        server: Arc<Server>,
        secrets: Arc<Memory>,
        pairing: Pairing,
        ui: FakeUi,
    }

    async fn world(user: &str) -> World {
        let server = Arc::new(Server::default());
        *server.user.lock().unwrap() = user.to_owned();
        let origin = serve(server.clone()).await;
        let dir = std::env::temp_dir().join(format!(
            "dozo-pairing-{}-{}",
            std::process::id(),
            origin.port().unwrap()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let secrets = Arc::new(Memory::default());
        let ui = FakeUi::default();
        ui.signed_in.store(true, Ordering::SeqCst);
        World {
            pairing: Pairing::new(origin, dir, secrets.clone()),
            server,
            secrets,
            ui,
        }
    }

    fn answer(ui: &FakeUi, answers: &[bool]) {
        ui.answers.lock().unwrap().extend_from_slice(answers);
    }

    #[tokio::test]
    async fn turning_it_on_asks_naming_the_server_and_keeps_the_token_in_the_keyring() {
        let w = world("a").await;
        answer(&w.ui, &[true]);
        let outcome = w.pairing.turn_on(&w.ui).await;
        assert_eq!(outcome, Ok(Outcome::Connected("t1".into())));
        assert_eq!(*w.ui.asked.lock().unwrap(), vec!["127.0.0.1".to_owned()]);
        assert_eq!(w.pairing.consent(), Some(Some("a".into())));
        let file = std::fs::read_to_string(w.pairing.file("")).unwrap();
        assert!(!file.contains("t1"), "the token is not in the file");
        assert_eq!(
            w.secrets.get(w.pairing.origin().as_str()).unwrap(),
            Some("t1".into())
        );
        assert_eq!(w.pairing.token().await, Some("t1".into()));
    }

    #[tokio::test]
    async fn without_a_keyring_nothing_is_paired() {
        let w = world("a").await;
        w.secrets.broken.store(true, Ordering::SeqCst);
        answer(&w.ui, &[true]);
        assert_eq!(w.pairing.turn_on(&w.ui).await, Err(Failure::Keyring));
        assert_eq!(w.server.issued.load(Ordering::SeqCst), 0);
        assert_eq!(w.pairing.consent(), None);
    }

    #[tokio::test]
    async fn signed_out_it_waits_and_pairs_after_sign_in() {
        let w = world("a").await;
        w.ui.signed_in.store(false, Ordering::SeqCst);
        answer(&w.ui, &[true]);
        assert_eq!(w.pairing.turn_on(&w.ui).await, Ok(Outcome::SignedOut));
        w.ui.signed_in.store(true, Ordering::SeqCst);
        assert_eq!(
            w.pairing.pair(&w.ui).await,
            Ok(Outcome::Connected("t1".into()))
        );
    }

    #[tokio::test]
    async fn a_sign_out_keeps_the_answer_for_the_same_account_and_asks_another() {
        let w = world("a").await;
        answer(&w.ui, &[true]);
        w.pairing.turn_on(&w.ui).await.unwrap();
        // Signed out: the token goes, the answer stays.
        w.pairing.ended(true).await;
        assert_eq!(w.pairing.token().await, None);
        assert_eq!(w.pairing.consent(), Some(Some("a".into())));
        // The same account signs in again: paired without asking.
        assert_eq!(
            w.pairing.pair(&w.ui).await,
            Ok(Outcome::Connected("t2".into()))
        );
        assert_eq!(w.ui.asked.lock().unwrap().len(), 1);
        // Another account: asked again, and a no ends the new pairing on the server.
        w.pairing.ended(true).await;
        *w.server.user.lock().unwrap() = "b".into();
        assert_eq!(w.pairing.pair(&w.ui).await, Ok(Outcome::Declined));
        assert_eq!(w.ui.asked.lock().unwrap().len(), 2);
        assert_eq!(*w.server.revoked.lock().unwrap(), vec!["t3".to_owned()]);
        assert_eq!(w.pairing.consent(), None);
        assert_eq!(w.pairing.token().await, None);
    }

    #[tokio::test]
    async fn another_account_that_is_allowed_takes_over() {
        let w = world("a").await;
        answer(&w.ui, &[true, true]);
        w.pairing.turn_on(&w.ui).await.unwrap();
        w.pairing.ended(true).await;
        *w.server.user.lock().unwrap() = "b".into();
        assert_eq!(
            w.pairing.pair(&w.ui).await,
            Ok(Outcome::Connected("t2".into()))
        );
        assert_eq!(w.pairing.consent(), Some(Some("b".into())));
    }

    #[tokio::test]
    async fn removed_in_settings_ends_the_answer_too() {
        let w = world("a").await;
        answer(&w.ui, &[true]);
        w.pairing.turn_on(&w.ui).await.unwrap();
        w.pairing.ended(false).await;
        assert_eq!(w.pairing.consent(), None);
        assert_eq!(w.secrets.get(w.pairing.origin().as_str()).unwrap(), None);
    }

    #[tokio::test]
    async fn turned_off_offline_the_revoke_waits_and_blocks_a_new_pairing() {
        let w = world("a").await;
        answer(&w.ui, &[true, true]);
        w.pairing.turn_on(&w.ui).await.unwrap();
        w.server.down.store(true, Ordering::SeqCst);
        assert_eq!(w.pairing.turn_off().await, Err(Failure::RevokePending));
        // Nothing connects, the answer is gone, the token waits in the keyring.
        assert_eq!(w.pairing.token().await, None);
        assert_eq!(w.pairing.consent(), None);
        assert!(w.pairing.revoke_pending());
        assert_eq!(
            pending_origins(&w.pairing.dir),
            vec![w.pairing.origin().clone()]
        );
        // Turning it on again first has to end the old pairing.
        assert_eq!(w.pairing.turn_on(&w.ui).await, Err(Failure::RevokePending));
        assert!(w.ui.asked.lock().unwrap().len() == 1);
        assert_eq!(w.server.issued.load(Ordering::SeqCst), 1);
        // The server is back: the retry ends it, then a new pairing can start.
        w.server.down.store(false, Ordering::SeqCst);
        assert!(w.pairing.finish_revoke().await);
        assert_eq!(*w.server.revoked.lock().unwrap(), vec!["t1".to_owned()]);
        assert!(pending_origins(&w.pairing.dir).is_empty());
        assert_eq!(
            w.pairing.turn_on(&w.ui).await,
            Ok(Outcome::Connected("t2".into()))
        );
    }

    #[tokio::test]
    async fn turned_off_while_pairing_the_new_token_is_ended() {
        let w = world("a").await;
        answer(&w.ui, &[true]);
        let consent = w.pairing.file(".consent");
        *w.ui.on_cookies.lock().unwrap() = Some(Box::new(move || {
            let _ = std::fs::remove_file(consent);
        }));
        assert_eq!(w.pairing.turn_on(&w.ui).await, Ok(Outcome::Declined));
        assert_eq!(*w.server.revoked.lock().unwrap(), vec!["t1".to_owned()]);
        assert_eq!(w.pairing.token().await, None);
    }

    #[tokio::test]
    async fn a_refused_pairing_turns_it_off_with_the_server_s_reason() {
        let w = world("a").await;
        answer(&w.ui, &[true]);
        w.server.down.store(true, Ordering::SeqCst);
        assert_eq!(w.pairing.turn_on(&w.ui).await, Err(Failure::Server(None)));
        assert_eq!(w.pairing.consent(), None);
    }

    #[test]
    fn the_device_names_itself() {
        let name = device_name();
        assert!(!name.is_empty() && name.chars().count() <= 128);
        assert!(["darwin", "win32", "linux"].contains(&platform()));
    }
}
