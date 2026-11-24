//! The paired computer's connection: one outbound WebSocket to the server's
//! `/api/devices/connect`, authenticated with the device token. The server never connects in.
//! Messages are upstream's (`packages/adapters/src/user-device-protocol.ts`): the server sends
//! `request`, `cancel` and `revoked`; this computer answers with `frame`s tagged by request id.

use std::collections::HashMap;
use std::hash::{BuildHasher, RandomState};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tauri::Url;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, MissedTickBehavior, interval, sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error, Message};

use crate::device_run::{CANCELLED, LOST, MAX_MESSAGE_BYTES, Reply, Runner, until};

pub const CONNECT_PATH: &str = "/api/devices/connect";
/// Carries the reason on a refused connection, which has no message to put it in.
const REVOKED_HEADER: &str = "x-rakazo-device-revoked";
const PING: Duration = Duration::from_secs(30);
/// What this computer can do, sent on connecting so the server offers only these tools
/// (`packages/adapters/src/dozo-device-capabilities.ts`): commands, and the bot's own browser
/// when one is installed and `browser::DECLARED` (macOS and Linux). No screen control.
const CAPABILITIES_HEADER: &str = "x-dozo-device-capabilities";

/// Why the server ended this computer's pairing. `Some("session-ended")`: the sign-in that
/// paired it ended, so the next sign-in may pair again.
pub type Revoked = Option<String>;

pub struct Options {
    pub server: Url,
    pub token: String,
    pub runner: Arc<Runner>,
    pub retry: (Duration, Duration),
    /// How long what commands left running survives a dropped connection that does not come
    /// back.
    pub grace: Duration,
}

/// The grace a dropped connection gets before what commands left running is stopped.
pub const GRACE: Duration = Duration::from_secs(60);

/// Connects and keeps reconnecting until `stop` turns true or the server revokes this
/// computer, which it returns. Commands in flight stop with the connection (their responses
/// could not arrive); what they left running gets `grace` to see the connection back, and then
/// only its process groups stop. A revoke stops everything.
pub async fn run(options: Options, mut stop: watch::Receiver<bool>) -> Option<Revoked> {
    let mut url = options.server.join(CONNECT_PATH).ok()?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).ok()?;
    let mut attempt = 0u32;
    let sessions = Arc::new(AtomicU64::new(0));
    loop {
        if *stop.borrow() {
            return None;
        }
        let opened = Instant::now();
        match session(&url, &options, &mut stop, &sessions).await {
            Ended::Revoked(reason) => {
                options.runner.stop_all(true);
                return Some(reason);
            }
            // Whoever stopped it (turning access off, another server, quitting) stops the rest.
            Ended::Stopped => return None,
            Ended::Lost => {
                let seen = sessions.load(Ordering::SeqCst);
                let (runner, sessions, stop) =
                    (options.runner.clone(), sessions.clone(), stop.clone());
                let grace = options.grace;
                tokio::spawn(async move {
                    sleep(grace).await;
                    if sessions.load(Ordering::SeqCst) == seen && !*stop.borrow() {
                        tokio::task::spawn_blocking(move || runner.stop_all(false));
                    }
                });
            }
        }
        if opened.elapsed() >= PING {
            attempt = 0;
        }
        // Full jitter keeps many computers from reconnecting in lockstep after a restart.
        let (min, max) = options.retry;
        let ceiling = max.min(min.saturating_mul(1 << attempt.min(16)));
        attempt += 1;
        let delay = min / 2 + ceiling.mul_f64(jitter());
        tokio::select! {
            () = sleep(delay) => {}
            () = until(&mut stop) => return None,
        }
    }
}

enum Ended {
    Revoked(Revoked),
    Stopped,
    Lost,
}

fn jitter() -> f64 {
    (RandomState::new().hash_one(Instant::now()) % 10_000) as f64 / 10_000.0
}

async fn session(
    url: &Url,
    options: &Options,
    stop: &mut watch::Receiver<bool>,
    sessions: &AtomicU64,
) -> Ended {
    let Ok(mut request) = url.as_str().into_client_request() else {
        return Ended::Stopped;
    };
    let Ok(bearer) = HeaderValue::from_str(&format!("Bearer {}", options.token)) else {
        return Ended::Stopped;
    };
    request.headers_mut().insert("authorization", bearer);
    let agents = options.runner.agent_ids().await;
    request.headers_mut().insert(
        CAPABILITIES_HEADER,
        capabilities_header(
            crate::browser::DECLARED,
            options.runner.browser_available(),
            options.runner.passwords_declared(),
            &agents,
        ),
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES));
    let connecting = tokio_tungstenite::connect_async_with_config(request, Some(config), false);
    let socket = tokio::select! {
        connected = timeout(Duration::from_secs(15), connecting) => connected,
        () = until(stop) => return Ended::Stopped,
    };
    let socket = match socket {
        Ok(Ok((socket, _))) => socket,
        Ok(Err(Error::Http(response))) if response.status() == 401 => {
            let reason = response
                .headers()
                .get(REVOKED_HEADER)
                .and_then(|value| value.to_str().ok())
                .filter(|reason| *reason == "session-ended")
                .map(str::to_owned);
            return Ended::Revoked(reason);
        }
        _ => return Ended::Lost,
    };
    sessions.fetch_add(1, Ordering::SeqCst);
    let (mut sink, mut incoming) = socket.split();
    let (out, mut outgoing) = mpsc::channel::<String>(64);
    let calls: Arc<Mutex<HashMap<String, watch::Sender<u8>>>> = Arc::default();
    let mut ping = interval(PING);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ping.tick().await;
    let mut alive = true;
    let ended = loop {
        tokio::select! {
            () = until(stop) => {
                let _ = sink.close().await;
                break Ended::Stopped;
            }
            Some(body) = outgoing.recv() => {
                if sink.send(Message::text(body)).await.is_err() {
                    break Ended::Lost;
                }
            }
            _ = ping.tick() => {
                // A silent network drop otherwise leaves the computer looking connected.
                if !alive || sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break Ended::Lost;
                }
                alive = false;
            }
            message = incoming.next() => {
                alive = true;
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break Ended::Lost,
                    Some(Ok(_)) => continue,
                };
                if let Some(revoked) = receive(text.as_str(), options, &out, &calls) {
                    break Ended::Revoked(revoked);
                }
            }
        }
    };
    // A lost response is never retried, so work in flight stops with the connection.
    for (_, cancel) in calls.lock().unwrap().drain() {
        let _ = cancel.send(LOST);
    }
    ended
}

/// What this computer offers: commands, the bot's own browser where the app has one
/// (`browser::DECLARED`) and a browser is installed, the password manager when it is on and its
/// program found, and `agent:<id>` for each agent the person allowed that is installed
/// (`device_agent.rs`).
fn capabilities(declared: bool, available: bool, passwords: bool, agents: &[&str]) -> String {
    let mut words = vec!["shell".to_owned()];
    if declared && available {
        words.push("browser".to_owned());
    }
    if passwords {
        words.push("passwords".to_owned());
    }
    words.extend(agents.iter().map(|id| format!("agent:{id}")));
    words.join(",")
}

/// The header: what this computer offers. A word it cannot carry leaves the plain header, never
/// none.
pub(crate) fn capabilities_header(
    declared: bool,
    available: bool,
    passwords: bool,
    agents: &[&str],
) -> HeaderValue {
    HeaderValue::from_str(&capabilities(declared, available, passwords, agents))
        .or_else(|_| HeaderValue::from_str(&capabilities(declared, available, passwords, &[])))
        .unwrap_or_else(|_| HeaderValue::from_static("shell"))
}

/// Acts on one server message; `Some` when it revokes this computer.
fn receive(
    text: &str,
    options: &Options,
    out: &mpsc::Sender<String>,
    calls: &Arc<Mutex<HashMap<String, watch::Sender<u8>>>>,
) -> Option<Revoked> {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    let id = message
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.chars().count() <= 64);
    match (message.get("type").and_then(Value::as_str), id) {
        (Some("revoked"), _) => Some(
            message
                .get("reason")
                .and_then(Value::as_str)
                .filter(|reason| *reason == "session-ended")
                .map(str::to_owned),
        ),
        (Some("cancel"), Some(id)) => {
            if let Some(cancel) = calls.lock().unwrap().remove(id) {
                let _ = cancel.send(CANCELLED);
            }
            None
        }
        (Some("request"), Some(id)) => {
            let request = message.get("request").cloned()?;
            let mut active = calls.lock().unwrap();
            if active.contains_key(id) {
                return None;
            }
            let (cancel, cancelled) = watch::channel(0);
            active.insert(id.to_owned(), cancel);
            drop(active);
            let reply = Reply {
                id: id.to_owned(),
                out: out.clone(),
                cancel: cancelled,
            };
            let runner = options.runner.clone();
            let calls = calls.clone();
            let id = id.to_owned();
            tokio::spawn(async move {
                runner.handle(&request, &reply).await;
                calls.lock().unwrap().remove(&id);
            });
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

    /// The real relay (tests/relay_e2e.sh): this app's runner connects to the server's own device
    /// hub, the person has cleared a bot's browser here, and the server's `forgotten` reaches this
    /// computer and takes the mark; then again, with two runs of the bot asking at once.
    #[tokio::test]
    #[ignore = "needs the relay harness: tests/relay_e2e.sh"]
    async fn e2e_relay_forgotten_reaches_this_computer() {
        let shared = std::path::PathBuf::from(std::env::var("DOZO_RELAY_DIR").unwrap());
        let server = Url::parse(&std::env::var("DOZO_RELAY_SERVER").unwrap()).unwrap();
        let wait_for = |file: &str| {
            let path = shared.join(file);
            async move {
                for _ in 0..1200 {
                    if path.exists() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                panic!("no {}", path.display());
            }
        };
        wait_for("session.json").await;
        let session: serde_json::Value =
            serde_json::from_slice(&std::fs::read(shared.join("session.json")).unwrap()).unwrap();
        let key = crate::device_run::bot_key(session["botId"].as_str().unwrap());
        let dir = std::env::temp_dir().join(format!("dozo-relay-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        let runner = Runner::new(dir.join("data"), dir.join("home"));
        assert!(runner.browser_available(), "a browser is installed here");
        assert!(runner.clear_browser(&key).await);
        let (stop, stopped) = watch::channel(false);
        let options = Options {
            server,
            token: session["token"].as_str().unwrap().to_owned(),
            runner: runner.clone(),
            retry: (Duration::from_millis(200), Duration::from_secs(2)),
            grace: GRACE,
        };
        let connection = tokio::spawn(run(options, stopped));
        let gone = async || {
            for _ in 0..1200 {
                if !runner.browser_cleared(&key) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("the mark stayed");
        };
        gone().await;
        println!("E2E: relay: the server's forgotten reached this computer and took the mark");
        wait_for("clear-again").await;
        assert!(runner.clear_browser(&key).await);
        gone().await;
        println!("E2E: relay: with two runs of the bot asking, the mark went again");
        wait_for("done").await;
        std::fs::write(shared.join("computer-done"), b"").unwrap();
        let _ = stop.send(true);
        let _ = connection.await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The bot's browser is declared only where the app has one (macOS, Linux) and a browser is
    /// installed; Windows declares commands alone and has no browser.
    #[test]
    fn the_browser_is_declared_only_where_the_app_has_one() {
        assert_eq!(capabilities(true, true, false, &[]), "shell,browser");
        assert_eq!(capabilities(true, false, false, &[]), "shell");
        assert_eq!(capabilities(false, true, false, &[]), "shell");
        // The password manager is declared on its own terms: on, and the program found.
        assert_eq!(
            capabilities(true, true, true, &[]),
            "shell,browser,passwords"
        );
        assert_eq!(capabilities(true, false, true, &[]), "shell,passwords");
        assert_eq!(capabilities(false, false, true, &[]), "shell,passwords");
        assert_eq!(
            capabilities(true, true, false, &["antigravity-agent"]),
            "shell,browser,agent:antigravity-agent"
        );
        assert_eq!(
            capabilities(false, false, true, &["a", "b"]),
            "shell,passwords,agent:a,agent:b"
        );
        #[cfg(windows)]
        {
            const { assert!(!crate::browser::DECLARED) };
            assert!(crate::browser::find().is_none());
            let dir = std::env::temp_dir().join(format!("dozo-socket-win-{}", std::process::id()));
            assert!(!Runner::new(dir.join("data"), dir.join("home")).browser_available());
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        const {
            assert!(crate::browser::DECLARED)
        };
    }

    /// The header a connection sends says `passwords` only while the setting is on and the
    /// program is found, as the runner says it now.
    #[tokio::test]
    #[allow(clippy::result_large_err)] // The handshake callback's signature is tungstenite's.
    async fn the_connection_declares_passwords_only_while_on_and_found() {
        use crate::password_links::Passwords;
        use crate::password_manager::{Failure, Fut, Login, Part, PasswordManager, Secret};
        struct Here;
        impl PasswordManager for Here {
            fn logins(&self) -> Fut<'_, Result<Vec<Login>, Failure>> {
                Box::pin(async { Ok(Vec::new()) })
            }
            fn read(&self, _: &str, _: &str, _: Part) -> Fut<'_, Result<Secret, Failure>> {
                Box::pin(async { Err(Failure::Failed) })
            }
        }
        for (found, on, expected) in [
            (true, true, true),
            (true, false, false),
            (false, true, false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let server = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
            let (seen, header) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut seen = Some(seen);
                let check = move |request: &Request, response: Response| {
                    let declared = request.headers().get(CAPABILITIES_HEADER).unwrap();
                    let _ = seen
                        .take()
                        .unwrap()
                        .send(declared.to_str().unwrap().to_owned());
                    Ok(response)
                };
                let _socket = tokio_tungstenite::accept_hdr_async(stream, check).await;
                tokio::time::sleep(Duration::from_millis(300)).await;
            });
            let dir = std::env::temp_dir().join(format!(
                "dozo-socket-passwords-{}-{}",
                std::process::id(),
                jitter().to_bits()
            ));
            std::fs::create_dir_all(dir.join("home")).unwrap();
            let vault: Option<Arc<dyn PasswordManager>> = found.then(|| Arc::new(Here) as _);
            let passwords = Passwords::new(None, vault);
            passwords.set_enabled(on);
            let runner = Runner::with_passwords(dir.join("data"), dir.join("home"), passwords);
            let options = Options {
                server,
                token: "good".to_owned(),
                runner,
                retry: (Duration::from_millis(20), Duration::from_millis(40)),
                grace: Duration::from_millis(300),
            };
            let (stop, stopped) = watch::channel(false);
            let connection = tokio::spawn(run(options, stopped));
            let header = header.await.unwrap();
            assert_eq!(
                header.split(',').any(|name| name == "passwords"),
                expected,
                "{header}"
            );
            let _ = stop.send(true);
            let _ = connection.await;
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// A fake gateway on loopback: accepts only `Bearer good`, refuses `Bearer ended` as a
    /// signed-out pairing, and hands each accepted socket to the test.
    #[allow(clippy::result_large_err)] // The handshake callback's signature is tungstenite's.
    async fn gateway() -> (Url, mpsc::Receiver<Socket>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let (accepted, sockets) = mpsc::channel(4);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let accepted = accepted.clone();
                tokio::spawn(async move {
                    let check = |request: &Request, response: Response| {
                        let auth = request.headers().get("authorization");
                        assert_eq!(request.uri().path(), CONNECT_PATH);
                        if auth.is_some_and(|auth| auth == "Bearer good") {
                            let declared = request.headers().get(CAPABILITIES_HEADER);
                            // The browser only where the app has one and one is installed.
                            let available = crate::browser::find().is_some();
                            let expected =
                                capabilities(crate::browser::DECLARED, available, false, &[]);
                            assert_eq!(declared.unwrap(), expected.as_str());
                            return Ok(response);
                        }
                        let mut refused = ErrorResponse::new(None);
                        *refused.status_mut() = 401.try_into().unwrap();
                        if auth.is_some_and(|auth| auth == "Bearer ended") {
                            refused
                                .headers_mut()
                                .insert(REVOKED_HEADER, "session-ended".parse().unwrap());
                        }
                        Err(refused)
                    };
                    if let Ok(socket) = tokio_tungstenite::accept_hdr_async(stream, check).await {
                        let _ = accepted.send(socket).await;
                    }
                });
            }
        });
        (url, sockets)
    }

    fn options(server: Url, token: &str) -> (Options, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "dozo-device-socket-{}-{}",
            std::process::id(),
            jitter().to_bits()
        ));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        let options = Options {
            server,
            token: token.to_owned(),
            runner: Runner::new(dir.join("data"), dir.join("home")),
            retry: (Duration::from_millis(20), Duration::from_millis(40)),
            grace: Duration::from_millis(300),
        };
        (options, dir)
    }

    async fn send(socket: &mut Socket, message: Value) {
        socket
            .send(Message::text(message.to_string()))
            .await
            .unwrap();
    }

    /// The frames for one request id until `done` or `error`.
    async fn answer(socket: &mut Socket, id: &str) -> Vec<Value> {
        let mut frames = Vec::new();
        while let Some(Ok(message)) = socket.next().await {
            let Message::Text(text) = message else {
                continue;
            };
            let message: Value = serde_json::from_str(text.as_str()).unwrap();
            assert_eq!(message["type"], "frame");
            if message["id"] != id {
                continue;
            }
            let frame = message["frame"].clone();
            let last = frame.get("done").is_some() || frame.get("error").is_some();
            frames.push(frame);
            if last {
                break;
            }
        }
        frames
    }

    #[tokio::test]
    async fn it_answers_requests_over_the_socket() {
        let (url, mut sockets) = gateway().await;
        let (options, _dir) = options(url, "good");
        let (stop, stopped) = watch::channel(false);
        let client = tokio::spawn(run(options, stopped));
        let mut socket = sockets.recv().await.unwrap();
        send(
            &mut socket,
            json!({ "type": "request", "id": "a", "request": { "method": "environment", "botId": "b" } }),
        )
        .await;
        let frames = answer(&mut socket, "a").await;
        assert!(frames[0]["value"]["home"].is_string());
        assert_eq!(frames[1], json!({ "done": true }));
        send(
            &mut socket,
            json!({ "type": "request", "id": "p", "request": { "method": "provision", "botId": "b" } }),
        )
        .await;
        answer(&mut socket, "p").await;
        #[cfg(unix)]
        {
            send(
                &mut socket,
                json!({ "type": "request", "id": "e", "request": { "method": "execute",
                    "botId": "b", "command": { "argv": ["echo", "merhaba"] } } }),
            )
            .await;
            let frames = answer(&mut socket, "e").await;
            assert_eq!(
                frames,
                vec![
                    json!({ "value": { "type": "stdout", "data": "merhaba\n" } }),
                    json!({ "value": { "type": "exit", "code": 0 } }),
                    json!({ "done": true }),
                ]
            );
        }
        stop.send(true).unwrap();
        assert_eq!(client.await.unwrap(), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_request_stops_and_sends_nothing_more() {
        let (url, mut sockets) = gateway().await;
        let (options, _dir) = options(url, "good");
        let (_stop, stopped) = watch::channel(false);
        tokio::spawn(run(options, stopped));
        let mut socket = sockets.recv().await.unwrap();
        send(
            &mut socket,
            json!({ "type": "request", "id": "p", "request": { "method": "provision", "botId": "b" } }),
        )
        .await;
        answer(&mut socket, "p").await;
        send(
            &mut socket,
            json!({ "type": "request", "id": "s", "request": { "method": "execute",
                "botId": "b", "command": { "argv": ["sleep", "30"] } } }),
        )
        .await;
        sleep(Duration::from_millis(200)).await;
        send(&mut socket, json!({ "type": "cancel", "id": "s" })).await;
        send(
            &mut socket,
            json!({ "type": "request", "id": "after", "request": { "method": "isRunning", "botId": "b" } }),
        )
        .await;
        // The next frame on the socket belongs to the later request: the cancelled one is silent.
        let Some(Ok(Message::Text(text))) = socket.next().await else {
            panic!("no frame");
        };
        assert_eq!(
            serde_json::from_str::<Value>(text.as_str()).unwrap()["id"],
            "after"
        );
    }

    /// What a command left running survives a dropped connection that comes back in time.
    #[cfg(unix)]
    #[tokio::test]
    async fn leftovers_survive_a_drop_that_comes_back_in_time() {
        let (url, mut sockets) = gateway().await;
        let (options, _dir) = options(url, "good");
        let runner = options.runner.clone();
        let (stop, stopped) = watch::channel(false);
        tokio::spawn(run(options, stopped));
        let mut socket = sockets.recv().await.unwrap();
        send(
            &mut socket,
            json!({ "type": "request", "id": "p", "request": { "method": "provision", "botId": "b" } }),
        )
        .await;
        answer(&mut socket, "p").await;
        send(
            &mut socket,
            json!({ "type": "request", "id": "e", "request": { "method": "execute", "botId": "b",
                "command": { "argv": ["/bin/sh", "-c", "sleep 3 >/dev/null 2>&1 & exit 0"] } } }),
        )
        .await;
        answer(&mut socket, "e").await;
        assert_eq!(runner.tracked(), 1);
        drop(socket);
        let _back = sockets.recv().await.unwrap();
        sleep(Duration::from_millis(600)).await;
        assert_eq!(
            runner.tracked(),
            1,
            "the grace (300 ms) passed with the connection back"
        );
        stop.send(true).unwrap();
        runner.stop_all(true);
    }

    #[tokio::test]
    async fn a_revoke_message_ends_the_client_with_its_reason() {
        let (url, mut sockets) = gateway().await;
        let (options, _dir) = options(url, "good");
        let (_stop, stopped) = watch::channel(false);
        let client = tokio::spawn(run(options, stopped));
        let mut socket = sockets.recv().await.unwrap();
        send(
            &mut socket,
            json!({ "type": "revoked", "reason": "session-ended" }),
        )
        .await;
        assert_eq!(
            client.await.unwrap(),
            Some(Some("session-ended".to_owned()))
        );
    }

    #[tokio::test]
    async fn a_refused_token_ends_the_client() {
        let (url, _sockets) = gateway().await;
        let (ended, _dir) = options(url.clone(), "ended");
        let (_stop, stopped) = watch::channel(false);
        assert_eq!(
            run(ended, stopped.clone()).await,
            Some(Some("session-ended".to_owned()))
        );
        let (removed, _dir) = options(url, "removed");
        assert_eq!(run(removed, stopped).await, Some(None));
    }

    #[tokio::test]
    async fn it_reconnects_after_the_connection_drops() {
        let (url, mut sockets) = gateway().await;
        let (options, _dir) = options(url, "good");
        let (stop, stopped) = watch::channel(false);
        let client = tokio::spawn(run(options, stopped));
        let first = sockets.recv().await.unwrap();
        drop(first);
        let mut second = sockets.recv().await.unwrap();
        send(
            &mut second,
            json!({ "type": "request", "id": "x", "request": { "method": "prepare", "botId": "b" } }),
        )
        .await;
        assert_eq!(
            answer(&mut second, "x").await.last().unwrap(),
            &json!({ "done": true })
        );
        stop.send(true).unwrap();
        assert_eq!(client.await.unwrap(), None);
    }
}
