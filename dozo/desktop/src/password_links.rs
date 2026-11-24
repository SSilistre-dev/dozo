//! Logins linked to this computer's password manager. A link says: this opaque handle stands for
//! one login of the person's own password manager, for one site. The handle is made here and told
//! to the server (`Registry`), which keeps only the handle beside the login's name and site; the
//! value never leaves this computer. The links live in one file in the app's config folder, and
//! turning the setting off deletes it, forgets every site the person approved and tells the server.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::Url;
use tokio::sync::oneshot;

use crate::password_manager::{Failure, Fut, Login, PasswordManager};

/// The file's name in the app's config folder.
pub const FILE: &str = "password-logins.json";
const REGISTER_PATH: &str = "/api/devices/self/dozo-logins";
const HANDLE_LEN: usize = 22;
/// How long the person has to answer the question before a login is first filled on a site.
const PROMPT_TIME: Duration = Duration::from_secs(120);
const MAX_LINKS: usize = 200;

/// One linked login: the manager's own ids (never shown), the title the person sees, the site it
/// is for and the other sites the person approved for it.
#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub item: String,
    pub vault: String,
    pub title: String,
    pub origin: String,
    pub sites: Vec<String>,
}

impl Link {
    fn to_json(&self) -> Value {
        json!({ "item": self.item, "vault": self.vault, "title": self.title,
            "origin": self.origin, "sites": self.sites })
    }

    /// A link as it is read back, or none when anything about it is not as it was written.
    fn from_json(value: &Value) -> Option<Link> {
        let text = |key: &str| value.get(key)?.as_str().map(str::to_owned);
        let sites = value
            .get("sites")?
            .as_array()?
            .iter()
            .map(|site| https_origin(site.as_str()?))
            .collect::<Option<Vec<_>>>()?;
        let link = Link {
            item: text("item").filter(|id| crate::password_manager::valid_id(id))?,
            vault: text("vault").filter(|id| crate::password_manager::valid_id(id))?,
            title: text("title").filter(|title| !title.is_empty())?,
            origin: https_origin(&text("origin")?)?,
            sites,
        };
        Some(link)
    }
}

/// The links, in a file only this user can read.
pub struct Links {
    file: Option<PathBuf>,
    links: Mutex<BTreeMap<String, Link>>,
}

/// 22 random url-safe characters.
pub fn new_handle() -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bytes = [0u8; HANDLE_LEN];
    getrandom::fill(&mut bytes).expect("the system's random source");
    // 64 divides 256, so every character is as likely as any other.
    bytes
        .iter()
        .map(|byte| ALPHABET[usize::from(byte % 64)] as char)
        .collect()
}

fn valid_handle(handle: &str) -> bool {
    handle.len() == HANDLE_LEN
        && handle
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// The text itself when it is a canonical https origin (`https://host[:port]`, lower case, no
/// path), else none: the form every origin here is compared in. A host written in another
/// alphabet comes out in punycode, so it is not the text and is refused.
pub fn https_origin(text: &str) -> Option<String> {
    let url = Url::parse(text).ok()?;
    let origin = url.origin().ascii_serialization();
    (url.scheme() == "https" && origin == text).then_some(origin)
}

impl Links {
    /// The links in `file`, or none when there is no file or it is not ours.
    pub fn open(file: Option<PathBuf>) -> Links {
        let read = file
            .as_deref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let links = read
            .as_ref()
            .and_then(Value::as_object)
            .map(|saved| {
                saved
                    .iter()
                    .filter(|(handle, _)| valid_handle(handle))
                    .filter_map(|(handle, link)| Some((handle.clone(), Link::from_json(link)?)))
                    .take(MAX_LINKS)
                    .collect()
            })
            .unwrap_or_default();
        Links {
            file,
            links: Mutex::new(links),
        }
    }

    /// Writes the file whole or not at all; nothing to write to is fine (a runner without one).
    fn save(&self, links: &BTreeMap<String, Link>) -> std::io::Result<()> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let saved: serde_json::Map<String, Value> = links
            .iter()
            .map(|(handle, link)| (handle.clone(), link.to_json()))
            .collect();
        if let Some(folder) = file.parent() {
            std::fs::create_dir_all(folder)?;
        }
        crate::stack_setup::write_private(file, Value::Object(saved).to_string().as_bytes())
    }

    pub fn add(&self, link: Link) -> std::io::Result<String> {
        let mut links = self.links.lock().unwrap();
        if links.len() >= MAX_LINKS {
            return Err(std::io::Error::other("too many links"));
        }
        let mut handle = new_handle();
        while links.contains_key(&handle) {
            handle = new_handle();
        }
        let mut next = links.clone();
        next.insert(handle.clone(), link);
        self.save(&next)?;
        *links = next;
        Ok(handle)
    }

    pub fn get(&self, handle: &str) -> Option<Link> {
        self.links.lock().unwrap().get(handle).cloned()
    }

    /// Every link, by title.
    pub fn list(&self) -> Vec<(String, Link)> {
        let mut list: Vec<(String, Link)> = self
            .links
            .lock()
            .unwrap()
            .iter()
            .map(|(handle, link)| (handle.clone(), link.clone()))
            .collect();
        list.sort_by(|a, b| {
            a.1.title
                .to_lowercase()
                .cmp(&b.1.title.to_lowercase())
                .then(a.0.cmp(&b.0))
        });
        list
    }

    pub fn remove(&self, handle: &str) -> bool {
        let mut links = self.links.lock().unwrap();
        let mut next = links.clone();
        if next.remove(handle).is_none() {
            return false;
        }
        // Gone here even when the file cannot be written: a link must never outlive its removal.
        let _ = self.save(&next);
        *links = next;
        true
    }

    /// Remembers that the person approved `origin` for this link.
    pub fn approve(&self, handle: &str, origin: &str) -> std::io::Result<()> {
        let mut links = self.links.lock().unwrap();
        let mut next = links.clone();
        let Some(link) = next.get_mut(handle) else {
            return Ok(());
        };
        if link.sites.iter().any(|site| site == origin) {
            return Ok(());
        }
        link.sites.push(origin.to_owned());
        self.save(&next)?;
        *links = next;
        Ok(())
    }

    /// Forgets every link and deletes the file; the handles that were linked.
    pub fn clear(&self) -> Vec<String> {
        let mut links = self.links.lock().unwrap();
        let handles = links.keys().cloned().collect();
        links.clear();
        if let Some(file) = &self.file {
            let _ = std::fs::remove_file(file);
        }
        handles
    }
}

/// Asks the person before a login is first filled on a site. Only the person can answer.
pub trait FillPrompt: Send + Sync {
    fn ask(&self, title: &str, origin: &str) -> oneshot::Receiver<bool>;
}

/// The server's side of a link, told with the device token.
pub trait Registry: Send + Sync {
    fn register(&self, title: &str, origin: &str, handle: &str) -> Fut<'_, bool>;
    fn unregister(&self, handle: &str) -> Fut<'_, bool>;
}

/// The server's answer over HTTP, as the paired computer.
pub struct HttpRegistry {
    pub server: Url,
    pub token: String,
}

impl Registry for HttpRegistry {
    fn register(&self, title: &str, origin: &str, handle: &str) -> Fut<'_, bool> {
        let body = json!({ "title": title, "origin": origin, "handle": handle }).to_string();
        Box::pin(async move {
            let (Some(client), Ok(url)) = (
                crate::device_pairing::client(),
                self.server.join(REGISTER_PATH),
            ) else {
                return false;
            };
            let sent = client
                .post(url)
                .bearer_auth(&self.token)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await;
            sent.is_ok_and(|response| response.status().is_success())
        })
    }

    fn unregister(&self, handle: &str) -> Fut<'_, bool> {
        let path = format!("{REGISTER_PATH}/{handle}");
        Box::pin(async move {
            let (Some(client), Ok(url)) =
                (crate::device_pairing::client(), self.server.join(&path))
            else {
                return false;
            };
            let sent = client.delete(url).bearer_auth(&self.token).send().await;
            // Not found: it is gone already.
            sent.is_ok_and(|response| {
                response.status().is_success() || response.status().as_u16() == 404
            })
        })
    }
}

/// Why a login could not be linked.
#[derive(Debug, PartialEq, Eq)]
pub enum LinkError {
    /// Not one of the logins just listed.
    Unknown,
    /// The server did not take it.
    Server,
    /// This computer could not keep it.
    Disk,
}

/// What a fill needs: whether the setting is on, the links, the program, the prompt.
pub struct Passwords {
    enabled: AtomicBool,
    links: Links,
    vault: Option<Arc<dyn PasswordManager>>,
    prompt: OnceLock<Arc<dyn FillPrompt>>,
    /// One question at a time, so two fills of one login never ask twice.
    asking: tokio::sync::Mutex<()>,
    candidates: Mutex<Vec<Login>>,
}

impl Passwords {
    pub fn new(file: Option<PathBuf>, vault: Option<Arc<dyn PasswordManager>>) -> Arc<Self> {
        Arc::new(Self {
            enabled: AtomicBool::new(false),
            links: Links::open(file),
            vault,
            prompt: OnceLock::new(),
            asking: tokio::sync::Mutex::default(),
            candidates: Mutex::default(),
        })
    }

    /// The setting, as it is when the app starts: off forgets whatever an earlier run left.
    pub fn start(&self, on: bool) {
        if !on {
            self.links.clear();
        }
        self.set_enabled(on);
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Declared to servers: on, and the program is here.
    pub fn declared(&self) -> bool {
        self.enabled() && self.vault.is_some()
    }

    pub fn links(&self) -> &Links {
        &self.links
    }

    pub fn vault(&self) -> Option<Arc<dyn PasswordManager>> {
        self.vault.clone()
    }

    pub fn set_prompt(&self, prompt: Arc<dyn FillPrompt>) {
        let _ = self.prompt.set(prompt);
    }

    /// Steps 1 and 2 of a fill: the setting is on, the handle is linked, and the site is the
    /// link's own or one the person approved for it. Answers with the error code otherwise.
    pub fn allow(&self, handle: &str, origin: &str) -> Result<Link, &'static str> {
        if !self.enabled() {
            return Err("passwords-off");
        }
        let link = self.links.get(handle).ok_or("passwords-unlinked")?;
        let known = origin == link.origin || link.sites.iter().any(|site| site == origin);
        if https_origin(origin).is_none() || !known {
            return Err("passwords-origin");
        }
        Ok(link)
    }

    /// Step 5: the first fill of this link on this site asks the person once; Allow is
    /// remembered. Answers with the error code when they cancel, or nothing can ask.
    pub async fn confirm(&self, handle: &str, origin: &str) -> Result<(), &'static str> {
        let _one = self.asking.lock().await;
        let link = self.allow(handle, origin)?;
        if link.sites.iter().any(|site| site == origin) {
            return Ok(());
        }
        let prompt = self.prompt.get().ok_or("passwords-denied")?;
        let answered = tokio::time::timeout(PROMPT_TIME, prompt.ask(&link.title, origin)).await;
        if !matches!(answered, Ok(Ok(true))) {
            return Err("passwords-denied");
        }
        // Turned off or removed while the person was asked.
        self.allow(handle, origin)?;
        self.links
            .approve(handle, origin)
            .map_err(|_| "passwords-failed")
    }

    /// The logins the program lists now, kept so that picking one names it by its id only.
    pub async fn candidates(&self) -> Result<Vec<Login>, Failure> {
        let vault = self.vault.as_ref().ok_or(Failure::Failed)?;
        let logins = vault.logins().await?;
        *self.candidates.lock().unwrap() = logins.clone();
        Ok(logins)
    }

    /// Links the listed login with this item id.
    pub async fn link(&self, item: &str, registry: &dyn Registry) -> Result<(), LinkError> {
        let login = self
            .candidates
            .lock()
            .unwrap()
            .iter()
            .find(|login| login.item == item)
            .cloned()
            .ok_or(LinkError::Unknown)?;
        let origin = https_origin(&login.site).ok_or(LinkError::Unknown)?;
        let link = Link {
            item: login.item,
            vault: login.vault,
            title: login.title,
            origin,
            sites: Vec::new(),
        };
        // The handle is made and told to the server first; kept here only once it took it, and
        // taken back from the server if this computer cannot keep it.
        let handle = self.links.add(link.clone()).map_err(|_| LinkError::Disk)?;
        if registry.register(&link.title, &link.origin, &handle).await {
            return Ok(());
        }
        self.links.remove(&handle);
        Err(LinkError::Server)
    }

    /// Removes the link here, then on the server.
    pub async fn unlink(&self, handle: &str, registry: &dyn Registry) {
        if self.links.remove(handle) {
            registry.unregister(handle).await;
        }
    }

    /// Turns the setting off: no fill works from this moment, every link and approved site is
    /// forgotten and the server is told to drop each one.
    pub async fn turn_off(&self, registry: &dyn Registry) {
        self.set_enabled(false);
        for handle in self.links.clear() {
            registry.unregister(&handle).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::password_manager::{Failure, Part, Secret};

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dozo-links-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn link(origin: &str) -> Link {
        Link {
            item: "abcdefghij0123456789abcdef".to_owned(),
            vault: "zyxwvutsrq9876543210zyxwvu".to_owned(),
            title: "Bank".to_owned(),
            origin: origin.to_owned(),
            sites: Vec::new(),
        }
    }

    /// Records what the server was told.
    #[derive(Default)]
    struct Told {
        calls: Mutex<Vec<String>>,
        refuse: bool,
    }

    impl Registry for Told {
        fn register(&self, title: &str, origin: &str, handle: &str) -> Fut<'_, bool> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("POST {title} {origin} {handle}"));
            let ok = !self.refuse;
            Box::pin(async move { ok })
        }

        fn unregister(&self, handle: &str) -> Fut<'_, bool> {
            self.calls.lock().unwrap().push(format!("DELETE {handle}"));
            Box::pin(async { true })
        }
    }

    struct Listing(Vec<Login>);

    impl PasswordManager for Listing {
        fn logins(&self) -> Fut<'_, Result<Vec<Login>, Failure>> {
            let logins = self.0.clone();
            Box::pin(async move { Ok(logins) })
        }

        fn read(&self, _: &str, _: &str, _: Part) -> Fut<'_, Result<Secret, Failure>> {
            Box::pin(async { Err(Failure::Failed) })
        }
    }

    fn login() -> Login {
        Login {
            item: "abcdefghij0123456789abcdef".to_owned(),
            vault: "zyxwvutsrq9876543210zyxwvu".to_owned(),
            title: "Bank".to_owned(),
            site: "https://bank.example.com".to_owned(),
        }
    }

    #[test]
    fn a_handle_is_22_url_safe_characters_and_never_repeats() {
        let (a, b) = (new_handle(), new_handle());
        assert_eq!(a.len(), 22, "{a}");
        assert!(
            a.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        );
        assert_ne!(a, b);
    }

    #[test]
    fn an_origin_is_https_and_already_canonical() {
        assert_eq!(
            https_origin("https://bank.example.com").as_deref(),
            Some("https://bank.example.com")
        );
        assert_eq!(
            https_origin("https://bank.example.com:8443").as_deref(),
            Some("https://bank.example.com:8443")
        );
        for bad in [
            "http://bank.example.com",
            "https://bank.example.com/",
            "https://bank.example.com/login",
            "https://BANK.example.com",
            "https://user@bank.example.com",
            "https://bаnk.example.com",
            "ftp://bank.example.com",
            "bank.example.com",
            "",
        ] {
            assert_eq!(https_origin(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn links_are_kept_in_one_private_file_and_read_back() {
        let dir = dir("file");
        let file = dir.join(FILE);
        let links = Links::open(Some(file.clone()));
        let handle = links.add(link("https://bank.example.com")).unwrap();
        links.approve(&handle, "https://bank.example.com").unwrap();
        let again = Links::open(Some(file.clone()));
        let kept = again.get(&handle).unwrap();
        assert_eq!(kept.title, "Bank");
        assert_eq!(kept.sites, ["https://bank.example.com"]);
        assert_eq!(again.list().len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "{mode:o}");
        }
        assert!(again.remove(&handle));
        assert!(Links::open(Some(file)).get(&handle).is_none());
        // A file edited by hand keeps only entries that are well formed.
        let file = dir.join("hand.json");
        std::fs::write(
            &file,
            r#"{"short":{"item":"a","vault":"b","title":"t","origin":"https://a.example.com","sites":[]}}"#,
        )
        .unwrap();
        assert!(Links::open(Some(file)).list().is_empty());
    }

    #[test]
    fn a_fill_is_allowed_only_on_the_links_own_site_or_one_approved() {
        let passwords = Passwords::new(Some(dir("allow").join(FILE)), None);
        assert_eq!(
            passwords
                .allow("anything", "https://bank.example.com")
                .unwrap_err(),
            "passwords-off"
        );
        passwords.set_enabled(true);
        assert_eq!(
            passwords
                .allow("anything", "https://bank.example.com")
                .unwrap_err(),
            "passwords-unlinked"
        );
        let handle = passwords
            .links()
            .add(link("https://bank.example.com"))
            .unwrap();
        assert!(passwords.allow(&handle, "https://bank.example.com").is_ok());
        for other in [
            "https://evil.bank.example.com",
            "https://bank.example.com.evil.test",
            "https://bank.example.com:8443",
            "http://bank.example.com",
            "https://bank.example.com/",
            "https://BANK.example.com",
            // A lookalike with a Cyrillic "а", as the browser would write it in punycode, and
            // as a server might send it unconverted.
            "https://xn--bnk-sxd.example.com",
            "https://bаnk.example.com",
            "",
        ] {
            assert_eq!(
                passwords.allow(&handle, other).unwrap_err(),
                "passwords-origin",
                "{other}"
            );
        }
        passwords
            .links()
            .approve(&handle, "https://login.example.com")
            .unwrap();
        assert!(
            passwords
                .allow(&handle, "https://login.example.com")
                .is_ok()
        );
    }

    #[tokio::test]
    async fn turning_off_forgets_every_link_deletes_the_file_and_tells_the_server() {
        let dir = dir("off");
        let file = dir.join(FILE);
        let passwords = Passwords::new(Some(file.clone()), None);
        passwords.set_enabled(true);
        let first = passwords
            .links()
            .add(link("https://a.example.com"))
            .unwrap();
        let second = passwords
            .links()
            .add(link("https://b.example.com"))
            .unwrap();
        passwords
            .links()
            .approve(&first, "https://c.example.com")
            .unwrap();
        assert!(file.exists());
        let server = Told::default();
        passwords.turn_off(&server).await;
        assert!(!file.exists());
        assert!(passwords.links().list().is_empty());
        assert!(!passwords.enabled() && !passwords.declared());
        let mut calls = server.calls.lock().unwrap().clone();
        calls.sort();
        let mut expected = vec![format!("DELETE {first}"), format!("DELETE {second}")];
        expected.sort();
        assert_eq!(calls, expected);
        assert_eq!(
            passwords
                .allow(&first, "https://a.example.com")
                .unwrap_err(),
            "passwords-off"
        );
    }

    #[test]
    fn the_capability_is_declared_only_while_on_and_the_program_is_here() {
        let here: Arc<dyn PasswordManager> = Arc::new(Listing(Vec::new()));
        let with = Passwords::new(None, Some(here));
        assert!(!with.declared());
        with.set_enabled(true);
        assert!(with.declared());
        with.set_enabled(false);
        assert!(!with.declared());
        let without = Passwords::new(None, None);
        without.set_enabled(true);
        assert!(!without.declared());
    }

    #[tokio::test]
    async fn a_listed_login_is_linked_after_the_server_takes_it() {
        let dir = dir("link");
        let file = dir.join(FILE);
        let here: Arc<dyn PasswordManager> = Arc::new(Listing(vec![login()]));
        let passwords = Passwords::new(Some(file.clone()), Some(here));
        passwords.set_enabled(true);
        let server = Told::default();
        // Only a login just listed can be picked, by its id.
        assert_eq!(
            passwords.link("abcdefghij0123456789abcdef", &server).await,
            Err(LinkError::Unknown)
        );
        assert_eq!(passwords.candidates().await.unwrap(), [login()]);
        passwords
            .link("abcdefghij0123456789abcdef", &server)
            .await
            .unwrap();
        let (handle, kept) = passwords.links().list().remove(0);
        assert_eq!(kept.origin, "https://bank.example.com");
        assert_eq!(kept.title, "Bank");
        assert_eq!(
            server.calls.lock().unwrap().clone(),
            [format!("POST Bank https://bank.example.com {handle}")]
        );
        // A server that refuses leaves nothing behind.
        let refusing = Told {
            refuse: true,
            ..Told::default()
        };
        passwords.unlink(&handle, &server).await;
        assert!(passwords.links().list().is_empty());
        assert_eq!(
            server.calls.lock().unwrap().last().unwrap(),
            &format!("DELETE {handle}")
        );
        assert_eq!(
            passwords
                .link("abcdefghij0123456789abcdef", &refusing)
                .await,
            Err(LinkError::Server)
        );
        assert!(passwords.links().list().is_empty());
    }

    /// One request read whole and answered with `answer`; the request's head and body come back.
    async fn serve(answer: &'static str) -> (Url, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let seen = tokio::spawn(async move {
            let mut requests = Vec::new();
            while let Ok(Ok((mut stream, _))) =
                tokio::time::timeout(std::time::Duration::from_millis(800), listener.accept()).await
            {
                let mut buffer = vec![0u8; 8192];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                requests.push(String::from_utf8_lossy(&buffer[..read]).into_owned());
                let _ = stream.write_all(answer.as_bytes()).await;
            }
            requests
        });
        (url, seen)
    }

    #[tokio::test]
    async fn the_server_is_told_over_http_with_the_device_token_and_no_redirect() {
        let (server, seen) =
            serve("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}").await;
        let registry = HttpRegistry {
            server,
            token: "device-token".to_owned(),
        };
        assert!(
            registry
                .register("Bank", "https://bank.example.com", "h4ndl3h4ndl3h4ndl3h4nd")
                .await
        );
        assert!(registry.unregister("h4ndl3h4ndl3h4ndl3h4nd").await);
        let requests = seen.await.unwrap();
        assert_eq!(requests.len(), 2, "{requests:?}");
        assert!(requests[0].starts_with("POST /api/devices/self/dozo-logins HTTP/1.1"));
        assert!(
            requests[0]
                .to_lowercase()
                .contains("authorization: bearer device-token")
        );
        assert!(requests[0].contains(
            r#"{"handle":"h4ndl3h4ndl3h4ndl3h4nd","origin":"https://bank.example.com","title":"Bank"}"#
        ));
        assert!(
            requests[1].starts_with(
                "DELETE /api/devices/self/dozo-logins/h4ndl3h4ndl3h4ndl3h4nd HTTP/1.1"
            )
        );
        assert!(
            requests[1]
                .to_lowercase()
                .contains("authorization: bearer device-token")
        );

        let (server, seen) = serve("HTTP/1.1 302 Found\r\nlocation: /elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
        let registry = HttpRegistry {
            server,
            token: "device-token".to_owned(),
        };
        assert!(!registry.unregister("h4ndl3h4ndl3h4ndl3h4nd").await);
        assert_eq!(seen.await.unwrap().len(), 1);
    }
}
