//! The paired computer's connection: one outbound WebSocket to the server's
//! `/api/devices/connect`, authenticated with the device token. The server never connects in.
//! Messages are upstream's (`packages/adapters/src/user-device-protocol.ts`): the server sends
//! `request`, `cancel` and `revoked`; this computer answers with `frame`s tagged by request id.

use std::collections::HashMap;
use std::hash::{BuildHasher, RandomState};
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

use crate::device_run::{MAX_MESSAGE_BYTES, Reply, Runner, until};

pub const CONNECT_PATH: &str = "/api/devices/connect";
/// Carries the reason on a refused connection, which has no message to put it in.
const REVOKED_HEADER: &str = "x-rakazo-device-revoked";
const PING: Duration = Duration::from_secs(30);

/// Why the server ended this computer's pairing. `Some("session-ended")`: the sign-in that
/// paired it ended, so the next sign-in may pair again.
pub type Revoked = Option<String>;

pub struct Options {
    pub server: Url,
    pub token: String,
    pub runner: Arc<Runner>,
    pub retry: (Duration, Duration),
}

/// Connects and keeps reconnecting until `stop` turns true or the server revokes this
/// computer, which it returns. Every running command stops with the connection.
pub async fn run(options: Options, mut stop: watch::Receiver<bool>) -> Option<Revoked> {
    let mut url = options.server.join(CONNECT_PATH).ok()?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).ok()?;
    let mut attempt = 0u32;
    loop {
        if *stop.borrow() {
            return None;
        }
        let opened = Instant::now();
        match session(&url, &options, &mut stop).await {
            Ended::Revoked(reason) => {
                options.runner.stop_all();
                return Some(reason);
            }
            Ended::Stopped => {
                options.runner.stop_all();
                return None;
            }
            Ended::Lost => options.runner.stop_all(),
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

async fn session(url: &Url, options: &Options, stop: &mut watch::Receiver<bool>) -> Ended {
    let Ok(mut request) = url.as_str().into_client_request() else {
        return Ended::Stopped;
    };
    let Ok(bearer) = HeaderValue::from_str(&format!("Bearer {}", options.token)) else {
        return Ended::Stopped;
    };
    request.headers_mut().insert("authorization", bearer);
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
    let (mut sink, mut incoming) = socket.split();
    let (out, mut outgoing) = mpsc::channel::<String>(64);
    let calls: Arc<Mutex<HashMap<String, watch::Sender<bool>>>> = Arc::default();
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
        let _ = cancel.send(true);
    }
    ended
}

/// Acts on one server message; `Some` when it revokes this computer.
fn receive(
    text: &str,
    options: &Options,
    out: &mpsc::Sender<String>,
    calls: &Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
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
                let _ = cancel.send(true);
            }
            None
        }
        (Some("request"), Some(id)) => {
            let request = message.get("request").cloned()?;
            let mut active = calls.lock().unwrap();
            if active.contains_key(id) {
                return None;
            }
            let (cancel, cancelled) = watch::channel(false);
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
