//! Filling a login from the person's password manager into the bot's page, entirely on this
//! computer (`pageBrowserFillLogin`). The server names a node, a site, a handle and which field;
//! the value is read here, with the person's approval, and written straight into that node. It
//! never goes to the server and never into an answer the bot reads: whatever the page later says
//! that contains it is scrubbed (`Running::scrub`).
//!
//! The node is found in the one frame of the page that owns it, and that frame's address, as the
//! browser itself reports it, must be the site. The node is then read and written from a world of
//! the browser's own for that frame, which the frame's scripts cannot reach or change; the write
//! asks that world again for the site and the kind of field. The browser commands used here
//! (`Page.createIsolatedWorld`, `DOM.resolveNode`, `Runtime.callFunctionOn`) are called on the pipe
//! directly. None is in `ALLOWED`, so the server cannot send them itself.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::{Browsers, OFF_THE_WEB, Pipe, Running, signing_message, web_address};
use crate::password_links::Passwords;
use crate::password_manager::{Failure, Part};

const ORIGIN: &str = "passwords-origin";
const FIELD: &str = "passwords-field";
const FAILED: &str = "passwords-failed";
const LOCKED: &str = "passwords-locked";
/// What a picture of the page is answered with while a filled value is on it.
pub(super) const SCREENSHOT: &str = "passwords-screenshot";

/// The world each frame's node is read and written from.
const WORLD: &str = "dozo-fill";
const MAX_FRAMES: usize = 32;
/// How many values one browser holds back; the one after that is not filled.
const MAX_HIDDEN: usize = 64;
/// A code is held back for as long as it can be used.
const CODE_LIFETIME: Duration = Duration::from_secs(120);
/// A shorter value cannot be found in an answer without taking other words with it.
const MIN_HIDDEN: usize = 4;
const REDACTED: &str = "[redacted]";

/// Reads a node's own document origin and its kind, in the world above.
const PROBE: &str = r#"function () {
  const doc = this.ownerDocument;
  const attribute = this.getAttribute ? this.getAttribute('autocomplete') : '';
  return {
    origin: doc ? doc.location.origin : null,
    tag: this.localName,
    type: String(this.type || '').toLowerCase(),
    autocomplete: String(attribute || '').toLowerCase()
  };
}"#;

/// Writes the value, if the node's own document is still the site and the node is still a field
/// of the kind `rule` names. The value is an argument, never part of this text.
const WRITE: &str = r#"function (value, origin, rule) {
  const doc = this.ownerDocument;
  if (!doc || doc.location.origin !== origin || this.localName !== 'input') return false;
  const type = String(this.type || '').toLowerCase();
  const tokens = String(this.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  const named = rule.autocomplete !== '' && tokens.includes(rule.autocomplete)
    && type !== 'password' && type !== 'hidden';
  if (!rule.types.includes(type) && !named) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  this.focus();
  set.call(this, value);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}"#;

/// One `pageBrowserFillLogin`.
#[derive(Clone, Debug, PartialEq)]
pub struct Fill {
    /// The field's `backendNodeId`.
    pub node: u64,
    pub origin: String,
    pub handle: String,
    pub field: Part,
}

/// The input types a value goes into, and the `autocomplete` word that names such a field too.
fn rule(part: Part) -> (&'static [&'static str], &'static str) {
    match part {
        Part::Password => (&["password"], ""),
        Part::Username => (&["text", "email"], "username"),
        Part::Code => (&["text", "number", "tel"], "one-time-code"),
    }
}

/// The same rule as `WRITE` applies, from what `PROBE` read.
fn suits(probe: &Value, part: Part) -> bool {
    let (types, named) = rule(part);
    let kind = probe["type"].as_str().unwrap_or("");
    let names = probe["autocomplete"]
        .as_str()
        .is_some_and(|words| !named.is_empty() && words.split_whitespace().any(|w| w == named));
    probe["tag"] == "input"
        && (types.contains(&kind) || (names && kind != "password" && kind != "hidden"))
}

/// Every frame of the page, the page's own first: its id and address.
fn frames(tree: &Value) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut queue = vec![tree];
    while !queue.is_empty() && found.len() < MAX_FRAMES {
        let level = std::mem::take(&mut queue);
        for node in level {
            let frame = &node["frame"];
            if let (Some(id), Some(url)) = (frame["id"].as_str(), frame["url"].as_str()) {
                found.push((id.to_owned(), url.to_owned()));
            }
            queue.extend(node["childFrames"].as_array().into_iter().flatten());
        }
    }
    found
}

/// The node as an object in its own frame's world, when that frame's address is `origin`, and the
/// loader id of the page's top document (empty when the browser gave none).
async fn locate(
    pipe: &Pipe,
    session: &str,
    node: u64,
    origin: &str,
) -> Result<(String, String), &'static str> {
    let tree = pipe
        .call("Page.getFrameTree", json!({}), Some(session))
        .await
        .map_err(|_| FAILED)?;
    let loader = tree["frameTree"]["frame"]["loaderId"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    for (frame, url) in frames(&tree["frameTree"]) {
        let world = json!({ "frameId": frame, "worldName": WORLD });
        let Ok(world) = pipe
            .call("Page.createIsolatedWorld", world, Some(session))
            .await
        else {
            continue;
        };
        let Some(context) = world["executionContextId"].as_u64() else {
            continue;
        };
        let resolve = json!({ "backendNodeId": node, "executionContextId": context });
        let Ok(resolved) = pipe.call("DOM.resolveNode", resolve, Some(session)).await else {
            continue;
        };
        let Some(object) = resolved["object"]["objectId"].as_str() else {
            continue;
        };
        // This frame holds the node: its address, as the browser has it, is what counts.
        let there = tauri::Url::parse(&url)
            .ok()
            .map(|url| url.origin().ascii_serialization());
        return if there.as_deref() == Some(origin) {
            Ok((object.to_owned(), loader))
        } else {
            Err(ORIGIN)
        };
    }
    Err(FAILED)
}

/// A value held back from every answer, and until when (a password: until the browser ends).
pub(super) struct Held {
    value: String,
    until: Option<Instant>,
}

/// One held value in the forms a page or the browser may write it: as it is, as JSON writes it
/// and as an address carries it.
struct Needle {
    plain: String,
    json: String,
    url: String,
}

impl Running {
    /// Holds a password or code back from every later answer. False when it cannot be held (too
    /// short to find safely, or the list is full): the caller must not write it. A username is
    /// not a secret and is never held.
    pub(super) fn hide(&self, value: &str, part: Part) -> bool {
        self.hide_at(value, part, Instant::now())
    }

    fn hide_at(&self, value: &str, part: Part, now: Instant) -> bool {
        if part == Part::Username {
            return true;
        }
        if value.chars().count() < MIN_HIDDEN {
            return false;
        }
        let mut hidden = self.hidden.lock().unwrap();
        hidden.retain(|held| held.until.is_none_or(|until| until > now));
        let until = (part == Part::Code).then(|| now + CODE_LIFETIME);
        if let Some(held) = hidden.iter_mut().find(|held| held.value == value) {
            // Held for as long as the longest need of either.
            held.until = held.until.and(until);
        } else if hidden.len() < MAX_HIDDEN {
            hidden.push(Held {
                value: value.to_owned(),
                until,
            });
        } else {
            return false;
        }
        true
    }

    /// From now until the page's top frame commits another document, no picture of the page.
    fn hold_pictures(&self, loader: &str) {
        *self.pipe.filled.lock().unwrap() = Some(loader.to_owned());
    }

    pub(super) fn pictures_refused(&self) -> bool {
        self.pipe.filled.lock().unwrap().is_some()
    }

    /// The held values in every form, longest first.
    fn needles_at(&self, now: Instant) -> Vec<Needle> {
        let mut needles: Vec<Needle> = self
            .hidden
            .lock()
            .unwrap()
            .iter()
            .filter(|held| held.until.is_none_or(|until| until > now))
            .map(|held| {
                let json = json!(held.value).to_string();
                Needle {
                    plain: held.value.clone(),
                    json: json[1..json.len() - 1].to_owned(),
                    url: url_form(&held.value),
                }
            })
            .collect();
        needles.sort_by_key(|needle| std::cmp::Reverse(needle.plain.len()));
        needles
    }

    /// Replaces the held values in every string of an answer. Names are left as they are.
    pub(super) fn scrub(&self, answer: &mut Value) {
        let needles = self.needles_at(Instant::now());
        if !needles.is_empty() {
            scrub_value(answer, &needles);
        }
    }

    pub(super) fn scrub_text(&self, text: &str) -> String {
        scrub_str(text, &self.needles_at(Instant::now()))
    }
}

/// The value as `encodeURIComponent` writes it.
fn url_form(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn scrub_str(text: &str, needles: &[Needle]) -> String {
    let mut text = text.to_owned();
    for needle in needles {
        for form in [&needle.plain, &needle.json, &needle.url] {
            text = text.replace(form.as_str(), REDACTED);
        }
    }
    text
}

fn scrub_value(value: &mut Value, needles: &[Needle]) {
    match value {
        Value::String(text) => *text = scrub_str(text, needles),
        Value::Array(items) => items.iter_mut().for_each(|item| scrub_value(item, needles)),
        Value::Object(map) => map.values_mut().for_each(|item| scrub_value(item, needles)),
        _ => {}
    }
}

impl Browsers {
    /// Fills the node with the value, or answers with why not: an error code (`passwords-…`) or
    /// one of the browser's own plain messages. The steps are the contract's, in order.
    pub async fn fill_login(
        &self,
        key: &str,
        fill: &Fill,
        passwords: &Arc<Passwords>,
    ) -> Result<(), String> {
        // 1 and 2: the setting, the link, the site.
        passwords.allow(&fill.handle, &fill.origin)?;
        if let Some(site) = self.signing_site(key) {
            return Err(signing_message(&site));
        }
        let running = self.running(key).await?;
        let session = match running.page(self.local).await {
            Ok(session) => session,
            Err(error) => {
                self.forget(key, &running);
                return Err(error);
            }
        };
        let address = running.address().await?;
        if !address.is_empty() && !web_address(&address, self.local) {
            return Err(OFF_THE_WEB.to_owned());
        }
        let pipe = &running.pipe;
        // 3: the node's own frame.
        let (object, loader) = locate(pipe, &session, fill.node, &fill.origin).await?;
        // 4: the kind of field, asked of the node itself.
        let read = json!({ "objectId": object, "functionDeclaration": PROBE,
            "returnByValue": true, "silent": true });
        let probe = pipe
            .call("Runtime.callFunctionOn", read, Some(&session))
            .await
            .map_err(|_| FAILED)?;
        let probe = &probe["result"]["value"];
        if probe["origin"] != fill.origin {
            return Err(ORIGIN.to_owned());
        }
        if !suits(probe, fill.field) {
            return Err(FIELD.to_owned());
        }
        // 5: the first fill on this site asks the person.
        passwords.confirm(&fill.handle, &fill.origin).await?;
        if let Some(site) = self.signing_site(key) {
            return Err(signing_message(&site));
        }
        // 6: the value, in memory only.
        let link = passwords.allow(&fill.handle, &fill.origin)?;
        let vault = passwords.vault().ok_or(FAILED)?;
        let secret = vault
            .read(&link.item, &link.vault, fill.field)
            .await
            .map_err(|failure| match failure {
                Failure::Locked => LOCKED,
                Failure::Failed => FAILED,
            })?;
        let value = secret.as_str().ok_or(FAILED)?;
        // Hidden before it is written, so nothing the page says after can carry it; a value that
        // cannot be hidden is not written. A password or code on the page also ends pictures of it.
        if !running.hide(value, fill.field) {
            return Err(FAILED.to_owned());
        }
        if fill.field != Part::Username {
            running.hold_pictures(&loader);
        }
        // 7: written in the node's own frame, which checks the site and the field again.
        let (types, named) = rule(fill.field);
        let write = json!({ "objectId": object, "functionDeclaration": WRITE,
            "arguments": [{ "value": value }, { "value": fill.origin },
                { "value": { "types": types, "autocomplete": named } }],
            "returnByValue": true, "silent": true });
        let written = pipe
            .call("Runtime.callFunctionOn", write, Some(&session))
            .await
            .map_err(|_| FAILED)?;
        if written["result"]["value"] != true {
            return Err(ORIGIN.to_owned());
        }
        // 8: the buffer is overwritten as `secret` goes.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use serde_json::json;

    use super::super::tests::fake;
    use super::super::{Pipe, Running};
    use super::*;
    use crate::password_links::{FILE, FillPrompt, Link};
    use crate::password_manager::{Failure, Fut, Login, PasswordManager, Secret};

    const SECRET: &str = "s3cr\"et\\value";
    const ORIGIN: &str = "https://bank.example.com";

    /// The page the fake browser shows.
    #[derive(Clone)]
    struct Page {
        address: &'static str,
        /// Frame ids and addresses; the first is the page's own.
        frames: Vec<(&'static str, &'static str)>,
        /// The frame the node is in.
        node_in: &'static str,
        tag: &'static str,
        kind: &'static str,
        autocomplete: &'static str,
        /// What the node's own document says its origin is, at write time too.
        document_origin: &'static str,
        /// The write function's answer.
        writes: bool,
    }

    impl Default for Page {
        fn default() -> Self {
            Page {
                address: "https://bank.example.com/login",
                frames: vec![("main", "https://bank.example.com/login")],
                node_in: "main",
                tag: "input",
                kind: "password",
                autocomplete: "",
                document_origin: ORIGIN,
                writes: true,
            }
        }
    }

    type Log = Arc<Mutex<Vec<Value>>>;

    fn cdp(page: Page, log: Log) -> Arc<Pipe> {
        fake(
            move |request| {
                log.lock().unwrap().push(request.clone());
                let params = &request["params"];
                let ok = |result: Value| json!({ "result": result });
                let index = |frame: &str| page.frames.iter().position(|(id, _)| *id == frame);
                match request["method"].as_str().unwrap_or("") {
                    "Target.getTargetInfo" => ok(json!({ "targetInfo": { "url": page.address } })),
                    "Page.getFrameTree" => {
                        let frame = |(id, url): &(&str, &str)| json!({ "id": id, "url": url, "loaderId": "L1" });
                        let children: Vec<Value> = page.frames[1..]
                            .iter()
                            .map(|entry| json!({ "frame": frame(entry) }))
                            .collect();
                        ok(json!({ "frameTree": { "frame": frame(&page.frames[0]),
                            "childFrames": children } }))
                    }
                    "Page.createIsolatedWorld" => {
                        match index(params["frameId"].as_str().unwrap_or("")) {
                            Some(at) => ok(json!({ "executionContextId": 100 + at })),
                            None => json!({ "error": { "message": "No frame" } }),
                        }
                    }
                    "DOM.resolveNode" => {
                        let context = params["executionContextId"].as_u64().unwrap_or(0);
                        if Some((context - 100) as usize) == index(page.node_in) {
                            ok(json!({ "object": { "objectId": format!("node-{context}") } }))
                        } else {
                            json!({ "error": { "message": "Node with given id does not belong to the context" } })
                        }
                    }
                    "Runtime.callFunctionOn" => {
                        if params["functionDeclaration"] == super::PROBE {
                            ok(
                                json!({ "result": { "value": { "origin": page.document_origin,
                                "tag": page.tag, "type": page.kind,
                                "autocomplete": page.autocomplete } } }),
                            )
                        } else {
                            ok(json!({ "result": { "type": "boolean", "value": page.writes } }))
                        }
                    }
                    "Accessibility.getFullAXTree" => ok(json!({ "nodes": [
                        { "name": { "value": format!("Password is {SECRET} ok") } },
                        { "name": { "value": "Sign in" } },
                        { "raw": format!("\"{}\"", SECRET.replace('\\', "\\\\").replace('"', "\\\"")) } ] })),
                    _ => ok(json!({})),
                }
            },
            vec![],
        )
    }

    struct FakeVault {
        answer: Mutex<Result<String, Failure>>,
        reads: Mutex<Vec<(String, String, Part)>>,
    }

    impl PasswordManager for FakeVault {
        fn logins(&self) -> Fut<'_, Result<Vec<Login>, Failure>> {
            Box::pin(async { Ok(Vec::new()) })
        }

        fn read(&self, item: &str, vault: &str, part: Part) -> Fut<'_, Result<Secret, Failure>> {
            self.reads
                .lock()
                .unwrap()
                .push((item.to_owned(), vault.to_owned(), part));
            let answer = self.answer.lock().unwrap().clone();
            Box::pin(async move { answer.map(|value| Secret::new(value.into_bytes())) })
        }
    }

    struct FakePrompt {
        /// None: the question stays open until the asker gives up.
        answer: Option<bool>,
        asked: Mutex<Vec<(String, String)>>,
        asked_now: tokio::sync::Notify,
        /// Set once nobody waits for the answer any more (the question would be closed).
        closed: Arc<tokio::sync::Notify>,
    }

    impl FillPrompt for FakePrompt {
        fn ask(&self, title: &str, origin: &str) -> tokio::sync::oneshot::Receiver<bool> {
            self.asked
                .lock()
                .unwrap()
                .push((title.to_owned(), origin.to_owned()));
            self.asked_now.notify_one();
            let (mut answer, answered) = tokio::sync::oneshot::channel();
            match self.answer {
                Some(allow) => {
                    let _ = answer.send(allow);
                }
                None => {
                    let closed = self.closed.clone();
                    tokio::spawn(async move {
                        answer.closed().await;
                        closed.notify_one();
                    });
                }
            }
            answered
        }
    }

    /// Removes the test's folder when the test ends.
    struct Guard(std::path::PathBuf);

    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct Setup {
        browsers: Browsers,
        key: String,
        passwords: Arc<Passwords>,
        log: Log,
        vault: Arc<FakeVault>,
        prompt: Arc<FakePrompt>,
        handle: String,
        dir: std::path::PathBuf,
        _guard: Guard,
    }

    fn setup(name: &str, page: Page, prompt: bool) -> Setup {
        setup_with(name, page, Some(prompt))
    }

    fn setup_with(name: &str, page: Page, prompt: Option<bool>) -> Setup {
        let dir = std::env::temp_dir().join(format!("dozo-fill-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let vault = Arc::new(FakeVault {
            answer: Mutex::new(Ok(SECRET.to_owned())),
            reads: Mutex::default(),
        });
        let manager: Arc<dyn PasswordManager> = vault.clone();
        let passwords = Passwords::new(Some(dir.join(FILE)), Some(manager));
        passwords.set_enabled(true);
        let prompt = Arc::new(FakePrompt {
            answer: prompt,
            asked: Mutex::default(),
            asked_now: tokio::sync::Notify::new(),
            closed: Arc::default(),
        });
        passwords.set_prompt(prompt.clone());
        let handle = passwords
            .links()
            .add(Link {
                item: "abcdefghij0123456789abcdef".to_owned(),
                vault: "zyxwvutsrq9876543210zyxwvu".to_owned(),
                title: "Bank".to_owned(),
                origin: ORIGIN.to_owned(),
                sites: Vec::new(),
            })
            .unwrap();
        let log = Log::default();
        let pipe = cdp(page, log.clone());
        *pipe.session.lock().unwrap() = Some("page".to_owned());
        let browsers = Browsers::with(dir.join("profiles"), None, true);
        let running = Arc::new(Running {
            pipe: pipe.clone(),
            attach: tokio::sync::Mutex::default(),
            target: Mutex::new(Some("T".to_owned())),
            hidden: Mutex::default(),
            #[cfg(unix)]
            child: Mutex::new(None),
        });
        let key = crate::device_run::bot_key("bot-1");
        browsers.open.lock().unwrap().insert(key.clone(), running);
        Setup {
            browsers,
            key,
            passwords,
            log,
            vault,
            prompt,
            handle,
            _guard: Guard(dir.clone()),
            dir,
        }
    }

    impl Setup {
        fn fill(&self, field: Part) -> Fill {
            Fill {
                node: 7,
                origin: ORIGIN.to_owned(),
                handle: self.handle.clone(),
                field,
            }
        }

        async fn run(&self, fill: &Fill) -> Result<(), String> {
            self.browsers
                .fill_login(&self.key, fill, &self.passwords)
                .await
        }

        fn calls(&self, method: &str) -> Vec<Value> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call["method"] == method)
                .cloned()
                .collect()
        }

        /// The calls that wrote a value: `Runtime.callFunctionOn` with arguments.
        fn writes(&self) -> Vec<Value> {
            self.calls("Runtime.callFunctionOn")
                .into_iter()
                .filter(|call| {
                    call["params"]["arguments"]
                        .as_array()
                        .is_some_and(|arguments| !arguments.is_empty())
                })
                .collect()
        }

        fn reads(&self) -> usize {
            self.vault.reads.lock().unwrap().len()
        }

        fn asked(&self) -> Vec<(String, String)> {
            self.prompt.asked.lock().unwrap().clone()
        }
    }

    #[tokio::test]
    async fn the_value_is_written_as_an_argument_and_never_in_the_function() {
        let s = setup("write", Page::default(), true);
        s.run(&s.fill(Part::Password)).await.unwrap();
        assert_eq!(
            s.vault.reads.lock().unwrap().clone(),
            [(
                "abcdefghij0123456789abcdef".to_owned(),
                "zyxwvutsrq9876543210zyxwvu".to_owned(),
                Part::Password
            )]
        );
        assert_eq!(s.asked(), [("Bank".to_owned(), ORIGIN.to_owned())]);
        let writes = s.writes();
        assert_eq!(writes.len(), 1);
        let params = &writes[0]["params"];
        assert_eq!(params["arguments"][0]["value"], SECRET);
        assert_eq!(params["arguments"][1]["value"], ORIGIN);
        assert_eq!(params["objectId"], "node-100");
        assert_eq!(writes[0]["sessionId"], "page");
        let function = params["functionDeclaration"].as_str().unwrap();
        assert!(function.contains("location.origin") && !function.contains("s3cr"));
        // The value is in no call but as that one argument.
        for call in s.log.lock().unwrap().iter() {
            let mut text = call.to_string();
            if call["method"] == "Runtime.callFunctionOn"
                && call["params"]["arguments"][0]["value"] == SECRET
            {
                text = text.replace(&json!(SECRET).to_string(), "");
            }
            assert!(!text.contains("s3cr"), "{text}");
        }
        // The site is remembered: the second fill asks nobody.
        s.run(&s.fill(Part::Password)).await.unwrap();
        assert_eq!(s.asked().len(), 1);
        assert_eq!(s.reads(), 2);
        assert_eq!(s.passwords.links().get(&s.handle).unwrap().sites, [ORIGIN]);
    }

    #[tokio::test]
    async fn an_off_setting_or_an_unlinked_handle_touches_nothing() {
        let s = setup("off", Page::default(), true);
        s.passwords.set_enabled(false);
        assert_eq!(
            s.run(&s.fill(Part::Password)).await.unwrap_err(),
            "passwords-off"
        );
        s.passwords.set_enabled(true);
        let mut fill = s.fill(Part::Password);
        fill.handle = "someoneelseshandle0000".to_owned();
        assert_eq!(s.run(&fill).await.unwrap_err(), "passwords-unlinked");
        assert!(s.log.lock().unwrap().is_empty());
        assert_eq!((s.reads(), s.asked().len()), (0, 0));
    }

    #[tokio::test]
    async fn a_site_that_is_not_the_links_own_is_refused_before_anything_runs() {
        let s = setup("site", Page::default(), true);
        for other in [
            "https://evil.bank.example.com",
            "https://bank.example.com.evil.test",
            "http://bank.example.com",
            "https://xn--bnk-sxd.example.com",
            "https://bаnk.example.com",
        ] {
            let mut fill = s.fill(Part::Password);
            fill.origin = other.to_owned();
            assert_eq!(
                s.run(&fill).await.unwrap_err(),
                "passwords-origin",
                "{other}"
            );
        }
        assert!(s.log.lock().unwrap().is_empty());
        assert_eq!((s.reads(), s.asked().len()), (0, 0));
    }

    #[tokio::test]
    async fn a_node_in_a_foreign_frame_is_refused_before_the_person_is_asked() {
        let page = Page {
            frames: vec![
                ("main", "https://bank.example.com/login"),
                ("ad", "https://ads.example.net/frame"),
            ],
            node_in: "ad",
            // The frame's own script may claim anything; the browser's frame address decides.
            document_origin: ORIGIN,
            ..Page::default()
        };
        let s = setup("frame", page, true);
        assert_eq!(
            s.run(&s.fill(Part::Password)).await.unwrap_err(),
            "passwords-origin"
        );
        assert_eq!((s.reads(), s.asked().len()), (0, 0));
        assert!(s.writes().is_empty());
        // A frame of the same site is fine.
        let page = Page {
            frames: vec![
                ("main", "https://bank.example.com/login"),
                ("own", "https://bank.example.com/frame"),
            ],
            node_in: "own",
            ..Page::default()
        };
        let s = setup("frame-own", page, true);
        s.run(&s.fill(Part::Password)).await.unwrap();
        assert_eq!(s.calls("DOM.resolveNode").len(), 2);
    }

    #[tokio::test]
    async fn a_node_that_cannot_be_found_is_a_failure() {
        let page = Page {
            node_in: "gone",
            ..Page::default()
        };
        let s = setup("gone", page, true);
        assert_eq!(
            s.run(&s.fill(Part::Password)).await.unwrap_err(),
            "passwords-failed"
        );
        assert_eq!((s.reads(), s.asked().len()), (0, 0));
    }

    #[tokio::test]
    async fn the_field_must_be_of_the_kind_the_value_is_for() {
        let cases = [
            // (page's tag, type, autocomplete, which value) -> refused
            ("input", "text", "", Part::Password),
            ("input", "email", "", Part::Password),
            ("textarea", "", "", Part::Password),
            ("input", "password", "", Part::Username),
            ("input", "hidden", "username", Part::Username),
            ("input", "checkbox", "", Part::Code),
            ("div", "", "", Part::Username),
        ];
        for (tag, kind, autocomplete, field) in cases {
            let page = Page {
                tag,
                kind,
                autocomplete,
                ..Page::default()
            };
            let s = setup("field", page, true);
            let refused = s.run(&s.fill(field)).await.unwrap_err();
            assert_eq!(refused, "passwords-field", "{tag} {kind} {field:?}");
            assert_eq!((s.reads(), s.asked().len()), (0, 0));
        }
        for (kind, autocomplete, field) in [
            ("password", "", Part::Password),
            ("text", "", Part::Username),
            ("email", "", Part::Username),
            ("search", "section-a username", Part::Username),
            ("text", "", Part::Code),
            ("number", "", Part::Code),
            ("tel", "", Part::Code),
            ("search", "one-time-code", Part::Code),
        ] {
            let page = Page {
                kind,
                autocomplete,
                ..Page::default()
            };
            let s = setup("field-ok", page, true);
            s.run(&s.fill(field)).await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_person_who_says_cancel_stops_it_before_the_program_is_asked() {
        let s = setup("deny", Page::default(), false);
        assert_eq!(
            s.run(&s.fill(Part::Password)).await.unwrap_err(),
            "passwords-denied"
        );
        assert_eq!(s.reads(), 0);
        assert!(s.passwords.links().get(&s.handle).unwrap().sites.is_empty());
        assert!(s.writes().is_empty());
    }

    #[tokio::test]
    async fn a_locked_or_failing_program_writes_nothing() {
        for (failure, code) in [
            (Failure::Locked, "passwords-locked"),
            (Failure::Failed, "passwords-failed"),
        ] {
            let s = setup("program", Page::default(), true);
            *s.vault.answer.lock().unwrap() = Err(failure);
            assert_eq!(s.run(&s.fill(Part::Password)).await.unwrap_err(), code);
            assert!(s.writes().is_empty());
        }
    }

    #[tokio::test]
    async fn a_page_that_changed_site_before_the_write_gets_nothing() {
        let page = Page {
            writes: false,
            ..Page::default()
        };
        let s = setup("moved", page, true);
        let refused = s.run(&s.fill(Part::Password)).await.unwrap_err();
        assert_eq!(refused, "passwords-origin");
        assert!(!refused.contains("s3cr"));
    }

    #[tokio::test]
    async fn nothing_fills_while_the_person_signs_in() {
        let s = setup("signing", Page::default(), true);
        s.browsers.mark_signing(&s.key, Some("bank.example.com"));
        let refused = s.run(&s.fill(Part::Password)).await.unwrap_err();
        assert!(refused.contains("signing in"), "{refused}");
        assert_eq!(s.reads(), 0);
    }

    #[tokio::test]
    async fn what_the_page_says_later_never_carries_the_value() {
        let s = setup("scrub", Page::default(), true);
        let tree = json!({ "method": "Accessibility.getFullAXTree" });
        // Before a fill, nothing is hidden.
        let before = s.browsers.handle(&s.key, &tree).await.unwrap();
        assert!(before.to_string().contains("s3cr"));
        s.run(&s.fill(Part::Password)).await.unwrap();
        let after = s.browsers.handle(&s.key, &tree).await.unwrap();
        let text = after.to_string();
        assert!(!text.contains("s3cr"), "{text}");
        assert_eq!(
            after["result"]["nodes"][0]["name"]["value"],
            "Password is [redacted] ok"
        );
        assert_eq!(after["result"]["nodes"][1]["name"]["value"], "Sign in");
        // The same in what the browser's own error says.
        let running = s.browsers.current(&s.key).unwrap();
        assert_eq!(
            running.scrub_text(&format!("refused: {SECRET}")),
            "refused: [redacted]"
        );
        // Another bot's browser is not affected.
        let other = setup("scrub-other", Page::default(), true);
        let untouched = other.browsers.handle(&other.key, &tree).await.unwrap();
        assert!(untouched.to_string().contains("s3cr"));
    }

    fn navigated(params: Value) -> Value {
        json!({ "method": "Page.frameNavigated", "sessionId": "page", "params": params })
    }

    impl Setup {
        async fn tree(&self) -> String {
            let tree = json!({ "method": "Accessibility.getFullAXTree" });
            self.browsers
                .handle(&self.key, &tree)
                .await
                .unwrap()
                .to_string()
        }

        async fn picture(&self) -> Result<Value, String> {
            let shot = json!({ "method": "Page.captureScreenshot",
                "params": { "format": "jpeg", "quality": 60 } });
            self.browsers.handle(&self.key, &shot).await
        }

        fn running(&self) -> Arc<Running> {
            self.browsers.current(&self.key).unwrap()
        }

        fn answer(&self, value: &str) {
            *self.vault.answer.lock().unwrap() = Ok(value.to_owned());
        }
    }

    #[tokio::test]
    async fn the_65th_password_is_refused_and_nothing_is_written() {
        let s = setup("cap", Page::default(), true);
        for n in 0..MAX_HIDDEN {
            s.answer(&format!("pw-{n}-value"));
            s.run(&s.fill(Part::Password)).await.unwrap();
        }
        s.answer("one-too-many");
        let refused = s.run(&s.fill(Part::Password)).await.unwrap_err();
        assert_eq!(refused, "passwords-failed");
        assert_eq!(s.writes().len(), MAX_HIDDEN);
        // A value already held is hidden already: it can be filled again.
        s.answer("pw-0-value");
        s.run(&s.fill(Part::Password)).await.unwrap();
    }

    #[tokio::test]
    async fn a_username_is_never_held_and_never_fills_the_list() {
        let page = Page {
            kind: "text",
            ..Page::default()
        };
        let s = setup("user", page, true);
        s.answer(SECRET);
        s.run(&s.fill(Part::Username)).await.unwrap();
        for n in 0..MAX_HIDDEN + 6 {
            s.answer(&format!("user-{n}@example.com"));
            s.run(&s.fill(Part::Username)).await.unwrap();
        }
        // Nothing of it is scrubbed, and no picture is held back for it.
        assert!(s.tree().await.contains("s3cr"));
        assert!(s.picture().await.is_ok());
    }

    #[tokio::test]
    async fn a_code_is_forgotten_after_two_minutes_and_a_password_is_not() {
        let s = setup("expiry", Page::default(), true);
        let running = s.running();
        let now = Instant::now();
        assert!(running.hide_at("123456", Part::Code, now));
        assert!(running.hide_at("hunter2-pass", Part::Password, now));
        let held = |at: Instant| -> Vec<String> {
            running
                .needles_at(at)
                .into_iter()
                .map(|n| n.plain)
                .collect()
        };
        assert_eq!(held(now + Duration::from_secs(119)).len(), 2);
        assert_eq!(held(now + Duration::from_secs(121)), ["hunter2-pass"]);
        // Room: a full list refuses, and a code that expired makes room again.
        for n in 0..MAX_HIDDEN - 2 {
            assert!(running.hide_at(&format!("pw-{n}-value"), Part::Password, now));
        }
        assert!(!running.hide_at("one-too-many", Part::Password, now));
        assert!(running.hide_at("654321", Part::Code, now + Duration::from_secs(121)));
    }

    #[tokio::test]
    async fn a_value_too_short_to_scrub_safely_is_not_filled() {
        for (field, kind) in [(Part::Password, "password"), (Part::Code, "text")] {
            let page = Page {
                kind,
                ..Page::default()
            };
            let s = setup("short", page, true);
            for value in ["", "a", "abc"] {
                s.answer(value);
                let refused = s.run(&s.fill(field)).await.unwrap_err();
                assert_eq!(refused, "passwords-failed", "{field:?} {value:?}");
            }
            assert!(s.writes().is_empty());
            s.answer("abcd");
            s.run(&s.fill(field)).await.unwrap();
        }
    }

    #[tokio::test]
    async fn scrubbing_leaves_names_alone() {
        let s = setup("names", Page::default(), true);
        let running = s.running();
        assert!(running.hide_at("word", Part::Password, Instant::now()));
        let mut answer = json!({ "word": 1, "keyword": ["a word b"], "nested": { "sword": "w" } });
        running.scrub(&mut answer);
        assert_eq!(
            answer,
            json!({ "word": 1, "keyword": ["a [redacted] b"], "nested": { "sword": "w" } })
        );
    }

    #[tokio::test]
    async fn the_address_form_of_a_value_is_scrubbed_too() {
        let s = setup("encoded", Page::default(), true);
        s.run(&s.fill(Part::Password)).await.unwrap();
        s.running().pipe.receive(navigated(json!({
            "frame": { "id": "main", "loaderId": "L2",
                "url": "https://bank.example.com/next?p=s3cr%22et%5Cvalue" },
            "type": "Navigation" })));
        let metrics = json!({ "method": "Page.getLayoutMetrics" });
        let answer = s.browsers.handle(&s.key, &metrics).await.unwrap();
        let text = answer.to_string();
        assert!(!text.contains("s3cr"), "{text}");
        assert!(text.contains("next?p=[redacted]"), "{text}");
        assert_eq!(
            s.running().scrub_text("a%20b s3cr%22et%5Cvalue"),
            "a%20b [redacted]"
        );
    }

    #[tokio::test]
    async fn no_picture_of_a_page_while_a_filled_password_is_on_it() {
        let s = setup("picture", Page::default(), true);
        assert!(s.picture().await.is_ok());
        s.run(&s.fill(Part::Password)).await.unwrap();
        assert_eq!(s.picture().await.unwrap_err(), "passwords-screenshot");
        // None of these is a new document of the page.
        let running = s.running();
        for event in [
            json!({ "method": "Page.navigatedWithinDocument", "sessionId": "page",
                "params": { "frameId": "main", "url": "https://bank.example.com/login#x" } }),
            json!({ "method": "DOM.attributeModified", "sessionId": "page",
                "params": { "nodeId": 3, "name": "type", "value": "text" } }),
            navigated(json!({ "frame": { "id": "main", "loaderId": "L1",
                "url": "https://bank.example.com/login" }, "type": "Navigation" })),
            navigated(
                json!({ "frame": { "id": "ad", "parentId": "main", "loaderId": "L9",
                "url": "https://ads.example.net/" }, "type": "Navigation" }),
            ),
            navigated(json!({ "frame": { "id": "main", "loaderId": "L0",
                "url": "https://bank.example.com/login" }, "type": "BackForwardCacheRestore" })),
        ] {
            running.pipe.receive(event.clone());
            assert_eq!(
                s.picture().await.unwrap_err(),
                "passwords-screenshot",
                "{event}"
            );
        }
        // Another bot's browser, with no fill, is not held back.
        let other = setup("picture-other", Page::default(), true);
        assert!(other.picture().await.is_ok());
        // The top frame commits a new document: the filled one is gone.
        running.pipe.receive(navigated(
            json!({ "frame": { "id": "main", "loaderId": "L2",
            "url": "https://bank.example.com/home" }, "type": "Navigation" }),
        ));
        assert!(s.picture().await.is_ok());
    }

    #[tokio::test]
    async fn losing_the_page_session_does_not_give_pictures_back() {
        let s = setup("picture-detach", Page::default(), true);
        s.run(&s.fill(Part::Password)).await.unwrap();
        let running = s.running();
        // The page's session goes (a reattach would show the same document): still held.
        running
            .pipe
            .receive(json!({ "method": "Target.detachedFromTarget",
            "params": { "sessionId": "page" } }));
        assert!(running.pictures_refused());
    }

    #[tokio::test]
    async fn a_filled_code_holds_pictures_back_as_a_password_does() {
        let page = Page {
            kind: "text",
            ..Page::default()
        };
        let s = setup("picture-code", page, true);
        s.answer("123456");
        s.run(&s.fill(Part::Code)).await.unwrap();
        assert_eq!(s.picture().await.unwrap_err(), "passwords-screenshot");
    }

    #[tokio::test]
    async fn a_node_that_is_not_in_a_document_of_the_site_is_refused() {
        let site = ("main", "https://bank.example.com/login");
        let cases = [
            // An about:blank or srcdoc frame takes its parent's origin; its address is not the site.
            ("about:blank", vec![site, ("f", "about:blank")], ORIGIN),
            ("srcdoc", vec![site, ("f", "about:srcdoc")], ORIGIN),
            // A sandboxed frame has the site's address and an origin of its own.
            (
                "sandboxed",
                vec![site, ("f", "https://bank.example.com/frame")],
                "null",
            ),
            // The same host written with a trailing dot is another origin.
            (
                "trailing dot",
                vec![site, ("f", "https://bank.example.com./frame")],
                "https://bank.example.com.",
            ),
        ];
        for (name, frames, document_origin) in cases {
            let page = Page {
                frames,
                node_in: "f",
                document_origin,
                ..Page::default()
            };
            let s = setup("opaque", page, true);
            let refused = s.run(&s.fill(Part::Password)).await.unwrap_err();
            assert_eq!(refused, "passwords-origin", "{name}");
            assert_eq!((s.reads(), s.asked().len(), s.writes().len()), (0, 0, 0));
        }
        let s = setup("dot-origin", Page::default(), true);
        let mut fill = s.fill(Part::Password);
        fill.origin = "https://bank.example.com.".to_owned();
        assert_eq!(s.run(&fill).await.unwrap_err(), "passwords-origin");
        assert!(s.log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_question_nobody_waits_for_is_closed_and_counts_as_cancel() {
        let s = setup_with("wait", Page::default(), None);
        let answer = s
            .passwords
            .confirm_within(&s.handle, ORIGIN, Duration::from_millis(50))
            .await;
        assert_eq!(answer, Err("passwords-denied"));
        let closed = tokio::time::timeout(Duration::from_secs(5), s.prompt.closed.notified());
        closed.await.expect("the question was left open");
        assert!(s.passwords.links().get(&s.handle).unwrap().sites.is_empty());
        assert_eq!(s.reads(), 0);
    }

    /// The request as the server sends it, cancelled while the person is still being asked.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn a_cancelled_request_closes_its_question_and_approves_nothing() {
        use crate::device_run::{CANCELLED, Reply, Runner};
        let s = setup_with("cancelled", Page::default(), None);
        let runner = Runner::assemble(
            s.dir.join("data"),
            s.dir.join("home"),
            s.browsers,
            s.passwords.clone(),
        );
        let (out, _frames) = tokio::sync::mpsc::channel(8);
        let (_cancel, cancelled) = tokio::sync::watch::channel(0u8);
        let provision = json!({ "method": "provision", "botId": "bot-1" });
        let reply = Reply {
            id: "p".to_owned(),
            out,
            cancel: cancelled,
        };
        runner.handle(&provision, &reply).await;
        let (out, mut frames) = tokio::sync::mpsc::channel(8);
        let (cancel, cancelled) = tokio::sync::watch::channel(0u8);
        let fill = json!({ "method": "pageBrowserFillLogin", "botId": "bot-1", "runId": "run-1",
            "ref": 7, "origin": ORIGIN, "handle": s.handle, "field": "password" });
        let task = tokio::spawn({
            let runner = runner.clone();
            async move {
                let reply = Reply {
                    id: "r".to_owned(),
                    out,
                    cancel: cancelled,
                };
                runner.handle(&fill, &reply).await;
            }
        });
        let five = Duration::from_secs(5);
        let shown = tokio::time::timeout(five, s.prompt.asked_now.notified());
        shown.await.expect("the question was shown");
        cancel.send(CANCELLED).unwrap();
        let ended = tokio::time::timeout(five, task).await;
        assert!(
            ended.is_ok(),
            "the request went on waiting after it was cancelled"
        );
        let closed = tokio::time::timeout(five, s.prompt.closed.notified());
        closed.await.expect("the question was left open");
        assert!(frames.recv().await.is_none());
        assert!(s.passwords.links().get(&s.handle).unwrap().sites.is_empty());
        assert!(s.vault.reads.lock().unwrap().is_empty());
    }

    #[test]
    fn the_server_cannot_send_the_browser_commands_the_fill_uses() {
        for method in [
            "Runtime.callFunctionOn",
            "Runtime.evaluate",
            "Page.createIsolatedWorld",
            "DOM.resolveNode",
        ] {
            let sent = super::super::allowed(&json!({ "method": method, "params": {} }), false);
            assert!(sent.is_err(), "{method}");
        }
    }

    /// The request as the server sends it, answered in frames: filled, or a code, never the value.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn a_fill_request_is_answered_with_filled_or_a_code_and_nothing_else() {
        use crate::device_run::{Reply, Runner};
        let s = setup("wire", Page::default(), true);
        let runner = Runner::assemble(
            s.dir.join("data"),
            s.dir.join("home"),
            s.browsers,
            s.passwords.clone(),
        );
        let ask = |request: Value| {
            let runner = runner.clone();
            async move {
                let (out, mut frames) = tokio::sync::mpsc::channel(8);
                let (_cancel, cancelled) = tokio::sync::watch::channel(0u8);
                let reply = Reply {
                    id: "r1".to_owned(),
                    out,
                    cancel: cancelled,
                };
                runner.handle(&request, &reply).await;
                drop(reply);
                let mut answers = Vec::new();
                while let Some(frame) = frames.recv().await {
                    let frame: Value = serde_json::from_str(&frame).unwrap();
                    answers.push(frame["frame"].clone());
                }
                answers
            }
        };
        let fill = |field: &str, handle: &str| {
            json!({ "method": "pageBrowserFillLogin", "botId": "bot-1", "runId": "run-1",
                "ref": 7, "origin": ORIGIN, "handle": handle, "field": field })
        };
        let provision = ask(json!({ "method": "provision", "botId": "bot-1" })).await;
        assert!(provision[0].get("value").is_some());
        assert_eq!(
            ask(fill("password", &s.handle)).await,
            [
                json!({ "value": { "filled": true } }),
                json!({ "done": true })
            ]
        );
        assert_eq!(
            ask(fill("password", "someoneelseshandle0000")).await,
            [json!({ "error": "passwords-unlinked" })]
        );
        for bad in [
            json!({ "method": "pageBrowserFillLogin", "botId": "bot-1", "ref": "7",
                "origin": ORIGIN, "handle": s.handle, "field": "password" }),
            json!({ "method": "pageBrowserFillLogin", "botId": "bot-1", "ref": 7,
                "handle": s.handle, "field": "password" }),
            fill("pin", &s.handle),
        ] {
            assert_eq!(
                ask(bad).await,
                [json!({ "error": "Local computer request is invalid" })]
            );
        }
        s.passwords.set_enabled(false);
        assert_eq!(
            ask(fill("password", &s.handle)).await,
            [json!({ "error": "passwords-off" })]
        );
        assert!(!s.log.lock().unwrap().iter().any(|call| {
            call["method"] != "Runtime.callFunctionOn" && call.to_string().contains("s3cr")
        }));
    }
}
