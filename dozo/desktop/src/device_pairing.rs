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
const DEVICES_PATH: &str = "/api/devices";
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

/// The sign-in the pairing needs from the window.
pub trait SignIn: Send + Sync {
    /// The web view's cookies for the server as a `Cookie` header; `None` when signed out.
    fn cookies(&self) -> impl Future<Output = Option<String>> + Send;
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Paired for the allowed account: connect with this token.
    Connected(String),
    /// Allowed, but nobody is signed in: pairs on a later page load or focus.
    SignedOut,
    /// Not allowed (any more).
    Declined,
    /// Paired, but for another account than the one allowed. Kept as a pending revoke until the
    /// person answers: `adopt` it or `reject` it.
    OtherAccount,
}

#[derive(Debug, PartialEq)]
pub enum Failure {
    /// The server refused, with its own sentence when it gave one, or could not be reached.
    Server(Option<String>),
    /// No system keyring to keep the token in, or it did not answer in time.
    Keyring,
    /// A pairing could not be ended on the server yet.
    RevokePending,
}

/// A keyring that does not answer (a locked keyring's unlock prompt nobody answers) must not
/// hold the pairing up for ever.
#[cfg(not(test))]
const SECRET_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const SECRET_TIMEOUT: Duration = Duration::from_millis(300);

/// The saved, non-secret half of a pairing.
#[derive(Debug, PartialEq, Clone)]
struct Saved {
    device: String,
    user: String,
    revoking: bool,
}

/// One server's pairing. Every method returns within bounded time: network calls time out
/// after 15 seconds, keyring calls after `SECRET_TIMEOUT`; nothing here waits for the person.
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

    pub fn host(&self) -> String {
        self.origin.host_str().unwrap_or_default().to_owned()
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
        let call = tokio::task::spawn_blocking(move || match op {
            Secret::Get => secrets.get(&account),
            Secret::Set(token) => secrets.set(&account, &token).map(|()| None),
            Secret::Delete => secrets.delete(&account).map(|()| None),
            Secret::Probe => secrets
                .set(PROBE, "1")
                .and_then(|()| secrets.delete(PROBE))
                .map(|()| None),
        });
        match tokio::time::timeout(SECRET_TIMEOUT, call).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(error.to_string()),
            Err(_) => Err("the keyring did not answer".to_owned()),
        }
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

    /// The person allowed it in the prompt; the pairing follows.
    pub fn allow(&self) -> Result<(), Failure> {
        self.save_consent(None).map_err(|_| Failure::Server(None))
    }

    /// Pairs under the person's sign-in when allowed and not paired yet.
    pub async fn pair(&self, sign_in: &impl SignIn) -> Result<Outcome, Failure> {
        let Some(consent) = self.consent() else {
            return Ok(Outcome::Declined);
        };
        if !self.finish_revoke(sign_in).await {
            return Err(Failure::RevokePending);
        }
        if let Some(token) = self.token().await {
            return Ok(Outcome::Connected(token));
        }
        if self.secret(Secret::Probe).await.is_err() {
            return Err(Failure::Keyring);
        }
        let Some(cookies) = sign_in.cookies().await else {
            return Ok(Outcome::SignedOut);
        };
        let (token, saved) = match request_pairing(&self.origin, &cookies).await {
            Ok(paired) => paired,
            Err(None) => return Ok(Outcome::SignedOut),
            Err(Some(failure)) => return Err(failure),
        };
        // Turned off while the server answered.
        if self.consent().is_none() {
            self.end(&token, &saved).await;
            return Ok(Outcome::Declined);
        }
        // Another account signed in since the person allowed it: kept as revoking until they
        // answer, so a pairing nobody agreed to is ended even if the app quits meanwhile.
        if consent.as_deref().is_some_and(|user| user != saved.user) {
            self.park(&saved);
            return if self.secret(Secret::Set(token.clone())).await.is_ok() {
                Ok(Outcome::OtherAccount)
            } else {
                self.end(&token, &saved).await;
                Err(Failure::Keyring)
            };
        }
        if self.secret(Secret::Set(token.clone())).await.is_err() || self.save(&saved).is_err() {
            self.end(&token, &saved).await;
            return Err(Failure::Keyring);
        }
        if self.save_consent(Some(&saved.user)).is_err() {
            self.withdraw();
            self.finish_revoke(sign_in).await;
            return Err(Failure::Server(None));
        }
        Ok(Outcome::Connected(token))
    }

    /// The person allowed the other account: its pairing becomes the one in use.
    pub async fn adopt(&self) -> Result<Outcome, Failure> {
        let Some(saved) = self.saved().filter(|saved| saved.revoking) else {
            return Ok(Outcome::Declined);
        };
        if self.consent().is_none() {
            return Ok(Outcome::Declined);
        }
        let Ok(Some(token)) = self.secret(Secret::Get).await else {
            return Err(Failure::Keyring);
        };
        let kept = Saved {
            revoking: false,
            ..saved
        };
        if self.save(&kept).is_err() || self.save_consent(Some(&kept.user)).is_err() {
            self.withdraw();
            return Err(Failure::Server(None));
        }
        Ok(Outcome::Connected(token))
    }

    /// The person did not allow the other account: no consent, its pairing ended.
    pub async fn reject(&self, sign_in: &impl SignIn) -> Result<(), Failure> {
        self.withdraw();
        if self.finish_revoke(sign_in).await {
            Ok(())
        } else {
            Err(Failure::RevokePending)
        }
    }

    /// Marks a pairing as to be ended, before anything else is tried, so it is never left valid
    /// on the server unnoticed. Written even when the token cannot be kept: the person's
    /// sign-in can still end it by its device id.
    fn park(&self, saved: &Saved) {
        let _ = self.save(&Saved {
            revoking: true,
            ..saved.clone()
        });
    }

    /// Ends a pairing nobody keeps: now, or later as a pending revoke.
    async fn end(&self, token: &str, saved: &Saved) {
        if revoke(&self.origin, token).await {
            return;
        }
        self.park(saved);
        let _ = self.secret(Secret::Set(token.to_owned())).await;
    }

    /// Off at once, without the network: no consent, and the pairing marked to be ended.
    pub fn withdraw(&self) {
        self.remove_consent();
        if let Some(saved) = self.saved() {
            let _ = self.save(&Saved {
                revoking: true,
                ..saved
            });
        }
    }

    /// Tries to end a pending revoke; true when nothing is pending any more. With the token,
    /// as the computer; without it (the keyring lost or refused it), as the signed-in person,
    /// by the device id.
    pub async fn finish_revoke(&self, sign_in: &impl SignIn) -> bool {
        let Some(saved) = self.saved().filter(|saved| saved.revoking) else {
            return true;
        };
        let done = match self.secret(Secret::Get).await {
            Ok(Some(token)) => revoke(&self.origin, &token).await,
            _ => match sign_in.cookies().await {
                Some(cookies) => revoke_as_owner(&self.origin, &saved.device, &cookies).await,
                None => false,
            },
        };
        if done {
            self.forget().await;
        }
        done
    }

    /// The server ended the pairing. A sign-out keeps the consent for that account's next
    /// sign-in; anything else (removed in settings, token refused) ends it too.
    pub async fn ended(&self, signed_out: bool) {
        self.forget().await;
        if !signed_out {
            self.remove_consent();
        }
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

/// Ends a pairing on the server with its token; true once it no longer holds there. A token
/// the server does not know (401, 403, 404, 410) holds nothing either; a busy or failing server
/// (429, 5xx) or no answer is tried again later.
async fn revoke(origin: &Url, token: &str) -> bool {
    let (Some(client), Ok(url)) = (client(), origin.join(SELF_PATH)) else {
        return false;
    };
    match client.delete(url).bearer_auth(token).send().await {
        Ok(response) => gone(response.status().as_u16()),
        Err(_) => false,
    }
}

/// Ends a pairing as the signed-in person, by its device id. 404: already ended, or not this
/// person's device to keep.
async fn revoke_as_owner(origin: &Url, device: &str, cookies: &str) -> bool {
    let (Some(client), Ok(url)) = (client(), origin.join(&format!("{DEVICES_PATH}/{device}")))
    else {
        return false;
    };
    let request = client
        .delete(url)
        .header("cookie", cookies)
        .header("origin", origin.origin().ascii_serialization());
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            (200..300).contains(&status) || status == 404
        }
        Err(_) => false,
    }
}

fn gone(status: u16) -> bool {
    (200..300).contains(&status) || matches!(status, 401 | 403 | 404 | 410)
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
    use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct Memory {
        secrets: Mutex<HashMap<String, String>>,
        /// No keyring at all.
        broken: AtomicBool,
        /// The keyring refuses to keep a token (the probe still works).
        refuse_tokens: AtomicBool,
        /// The keyring never answers in time.
        hung: AtomicBool,
    }

    impl Memory {
        fn wait(&self) {
            if self.hung.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }

    impl Secrets for Memory {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.wait();
            Ok(self.secrets.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.wait();
            if self.broken.load(Ordering::SeqCst)
                || (account != PROBE && self.refuse_tokens.load(Ordering::SeqCst))
            {
                return Err("no keyring".into());
            }
            self.secrets
                .lock()
                .unwrap()
                .insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.wait();
            self.secrets.lock().unwrap().remove(account);
            Ok(())
        }
    }

    /// A fake server: pairs whoever sends a cookie as `user`, issuing devices d1, d2... with
    /// tokens t1, t2...; records revokes by token and by device id. `down` answers 503 to
    /// everything; `self_status` replaces the answer to a token revoke.
    #[derive(Default)]
    struct Server {
        user: Mutex<String>,
        issued: AtomicUsize,
        revoked: Mutex<Vec<String>>,
        removed: Mutex<Vec<String>>,
        down: AtomicBool,
        /// Goes down right after answering a pairing.
        down_after_pair: AtomicBool,
        self_status: AtomicU16,
    }

    fn header(text: &str, name: &str) -> Option<String> {
        text.lines().find_map(|line| {
            let lower = line.to_ascii_lowercase();
            lower
                .starts_with(name)
                .then(|| line[name.len()..].trim().to_owned())
        })
    }

    async fn read_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = stream.read(&mut buffer).await.unwrap_or(0);
            request.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&request).into_owned();
            let Some(head) = text.find("\r\n\r\n") else {
                if read == 0 {
                    return text;
                }
                continue;
            };
            let length = header(&text[..head], "content-length:")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if read == 0 || request.len() >= head + 4 + length {
                return text;
            }
        }
    }

    async fn serve(server: Arc<Server>) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let server = server.clone();
                tokio::spawn(async move {
                    let text = read_request(&mut stream).await;
                    let (status, body) = answer(&server, &text);
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

    fn answer(server: &Server, text: &str) -> (u16, String) {
        if server.down.load(Ordering::SeqCst) {
            return (503, String::new());
        }
        let cookie = header(text, "cookie:");
        if text.starts_with("POST /api/devices/pair ") {
            if cookie.is_none() {
                return (401, String::new());
            }
            let n = server.issued.fetch_add(1, Ordering::SeqCst) + 1;
            let user = server.user.lock().unwrap().clone();
            let body =
                json!({ "deviceId": format!("d{n}"), "userId": user, "token": format!("t{n}") });
            if server.down_after_pair.load(Ordering::SeqCst) {
                server.down.store(true, Ordering::SeqCst);
            }
            return (201, body.to_string());
        }
        if text.starts_with("DELETE /api/devices/self ") {
            let token = header(text, "authorization:").unwrap_or_default();
            server
                .revoked
                .lock()
                .unwrap()
                .push(token.replace("Bearer ", ""));
            return match server.self_status.load(Ordering::SeqCst) {
                0 => (204, String::new()),
                status => (status, String::new()),
            };
        }
        if let Some(rest) = text.strip_prefix("DELETE /api/devices/") {
            if cookie.is_none() {
                return (401, String::new());
            }
            let device = rest.split(' ').next().unwrap_or_default().to_owned();
            server.removed.lock().unwrap().push(device);
            return (204, String::new());
        }
        (404, String::new())
    }

    /// The window's sign-in; `on_cookies` runs once, as the pairing request is about to go out.
    #[derive(Default)]
    struct Window {
        signed_in: AtomicBool,
        on_cookies: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    impl SignIn for Window {
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
        window: Window,
    }

    impl World {
        fn token(&self) -> Option<String> {
            self.secrets.get(self.pairing.origin().as_str()).unwrap()
        }

        /// What the menu does when the person allows it.
        async fn turn_on(&self) -> Result<Outcome, Failure> {
            self.pairing.allow()?;
            self.pairing.pair(&self.window).await
        }

        async fn turn_off(&self) -> bool {
            self.pairing.withdraw();
            self.pairing.finish_revoke(&self.window).await
        }
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
        let window = Window::default();
        window.signed_in.store(true, Ordering::SeqCst);
        World {
            pairing: Pairing::new(origin, dir, secrets.clone()),
            server,
            secrets,
            window,
        }
    }

    #[tokio::test]
    async fn it_pairs_and_keeps_the_token_in_the_keyring_only() {
        let w = world("a").await;
        assert_eq!(w.turn_on().await, Ok(Outcome::Connected("t1".into())));
        assert_eq!(w.pairing.consent(), Some(Some("a".into())));
        let file = std::fs::read_to_string(w.pairing.file("")).unwrap();
        assert!(!file.contains("t1"), "the token is not in the file");
        assert_eq!(w.token(), Some("t1".into()));
        assert_eq!(w.pairing.token().await, Some("t1".into()));
        assert_eq!(w.pairing.host(), "127.0.0.1");
    }

    #[tokio::test]
    async fn without_a_keyring_nothing_is_paired() {
        let w = world("a").await;
        w.secrets.broken.store(true, Ordering::SeqCst);
        assert_eq!(w.turn_on().await, Err(Failure::Keyring));
        assert_eq!(w.server.issued.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_keyring_that_never_answers_gives_up_in_time() {
        let w = world("a").await;
        w.secrets.hung.store(true, Ordering::SeqCst);
        let started = std::time::Instant::now();
        assert_eq!(w.turn_on().await, Err(Failure::Keyring));
        assert!(started.elapsed() < Duration::from_millis(1500));
        assert_eq!(w.server.issued.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn signed_out_it_waits_and_pairs_after_sign_in() {
        let w = world("a").await;
        w.window.signed_in.store(false, Ordering::SeqCst);
        assert_eq!(w.turn_on().await, Ok(Outcome::SignedOut));
        w.window.signed_in.store(true, Ordering::SeqCst);
        assert_eq!(
            w.pairing.pair(&w.window).await,
            Ok(Outcome::Connected("t1".into()))
        );
    }

    #[tokio::test]
    async fn a_sign_out_keeps_the_answer_for_the_same_account_and_holds_another() {
        let w = world("a").await;
        w.turn_on().await.unwrap();
        w.pairing.ended(true).await;
        assert_eq!(w.pairing.token().await, None);
        assert_eq!(w.pairing.consent(), Some(Some("a".into())));
        // The same account again: paired without asking.
        assert_eq!(
            w.pairing.pair(&w.window).await,
            Ok(Outcome::Connected("t2".into()))
        );
        // Another account: held as a pending revoke until the person answers.
        w.pairing.ended(true).await;
        *w.server.user.lock().unwrap() = "b".into();
        assert_eq!(w.pairing.pair(&w.window).await, Ok(Outcome::OtherAccount));
        assert!(w.pairing.revoke_pending());
        assert_eq!(w.pairing.token().await, None);
        // No: ended on the server, and the answer is gone.
        assert_eq!(w.pairing.reject(&w.window).await, Ok(()));
        assert_eq!(*w.server.revoked.lock().unwrap(), vec!["t3".to_owned()]);
        assert_eq!(w.pairing.consent(), None);
        assert!(!w.pairing.revoke_pending());
    }

    #[tokio::test]
    async fn another_account_that_is_allowed_takes_over() {
        let w = world("a").await;
        w.turn_on().await.unwrap();
        w.pairing.ended(true).await;
        *w.server.user.lock().unwrap() = "b".into();
        assert_eq!(w.pairing.pair(&w.window).await, Ok(Outcome::OtherAccount));
        assert_eq!(w.pairing.adopt().await, Ok(Outcome::Connected("t2".into())));
        assert_eq!(w.pairing.consent(), Some(Some("b".into())));
        assert_eq!(w.pairing.token().await, Some("t2".into()));
    }

    #[tokio::test]
    async fn turned_off_while_the_other_account_is_asked_about_nothing_is_adopted() {
        let w = world("a").await;
        w.turn_on().await.unwrap();
        w.pairing.ended(true).await;
        *w.server.user.lock().unwrap() = "b".into();
        w.pairing.pair(&w.window).await.unwrap();
        w.pairing.withdraw();
        assert_eq!(w.pairing.adopt().await, Ok(Outcome::Declined));
        assert!(w.pairing.finish_revoke(&w.window).await);
        assert_eq!(*w.server.revoked.lock().unwrap(), vec!["t2".to_owned()]);
    }

    #[tokio::test]
    async fn removed_in_settings_ends_the_answer_too() {
        let w = world("a").await;
        w.turn_on().await.unwrap();
        w.pairing.ended(false).await;
        assert_eq!(w.pairing.consent(), None);
        assert_eq!(w.token(), None);
    }

    #[tokio::test]
    async fn turned_off_offline_the_revoke_waits_and_blocks_a_new_pairing() {
        let w = world("a").await;
        w.turn_on().await.unwrap();
        w.server.down.store(true, Ordering::SeqCst);
        assert!(!w.turn_off().await);
        assert_eq!(w.pairing.token().await, None);
        assert_eq!(w.pairing.consent(), None);
        assert_eq!(
            pending_origins(&w.pairing.dir),
            vec![w.pairing.origin().clone()]
        );
        assert_eq!(w.turn_on().await, Err(Failure::RevokePending));
        assert_eq!(w.server.issued.load(Ordering::SeqCst), 1);
        w.server.down.store(false, Ordering::SeqCst);
        assert!(w.pairing.finish_revoke(&w.window).await);
        assert_eq!(*w.server.revoked.lock().unwrap(), vec!["t1".to_owned()]);
        assert!(pending_origins(&w.pairing.dir).is_empty());
        assert_eq!(w.turn_on().await, Ok(Outcome::Connected("t2".into())));
    }

    #[tokio::test]
    async fn a_token_the_server_does_not_know_counts_as_revoked() {
        for status in [403, 404, 410] {
            let w = world("a").await;
            w.turn_on().await.unwrap();
            w.server.self_status.store(status, Ordering::SeqCst);
            assert!(w.turn_off().await, "{status}");
            assert!(!w.pairing.revoke_pending());
        }
    }

    #[tokio::test]
    async fn a_busy_server_keeps_the_revoke_pending() {
        let w = world("a").await;
        w.turn_on().await.unwrap();
        w.server.self_status.store(429, Ordering::SeqCst);
        assert!(!w.turn_off().await);
        assert!(w.pairing.revoke_pending());
    }

    #[tokio::test]
    async fn turned_off_while_pairing_the_new_token_is_ended() {
        let w = world("a").await;
        let consent = w.pairing.file(".consent");
        *w.window.on_cookies.lock().unwrap() = Some(Box::new(move || {
            let _ = std::fs::remove_file(consent);
        }));
        assert_eq!(w.turn_on().await, Ok(Outcome::Declined));
        assert_eq!(*w.server.revoked.lock().unwrap(), vec!["t1".to_owned()]);
        assert_eq!(w.pairing.token().await, None);
    }

    #[tokio::test]
    async fn a_token_that_cannot_be_kept_or_revoked_is_ended_by_the_sign_in_later() {
        let w = world("a").await;
        w.secrets.refuse_tokens.store(true, Ordering::SeqCst);
        w.server.down_after_pair.store(true, Ordering::SeqCst);
        assert_eq!(w.turn_on().await, Err(Failure::Keyring));
        // Neither kept nor revoked: the pending mark is on disk, without a token.
        assert!(w.pairing.revoke_pending());
        assert_eq!(w.token(), None);
        assert!(!w.pairing.finish_revoke(&w.window).await);
        // The server is back: the person's sign-in ends it by its device id.
        w.server.down.store(false, Ordering::SeqCst);
        w.server.down_after_pair.store(false, Ordering::SeqCst);
        assert!(w.pairing.finish_revoke(&w.window).await);
        assert_eq!(*w.server.removed.lock().unwrap(), vec!["d1".to_owned()]);
        assert!(!w.pairing.revoke_pending());
    }

    #[tokio::test]
    async fn a_refused_pairing_reports_the_server() {
        let w = world("a").await;
        w.server.down.store(true, Ordering::SeqCst);
        assert_eq!(w.turn_on().await, Err(Failure::Server(None)));
    }

    #[test]
    fn the_device_names_itself() {
        let name = device_name();
        assert!(!name.is_empty() && name.chars().count() <= 128);
        assert!(["darwin", "win32", "linux"].contains(&platform()));
    }
}
