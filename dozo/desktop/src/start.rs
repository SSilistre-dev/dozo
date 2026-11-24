//! The window's first page. A server that is already chosen, and is not the one on this computer,
//! is loaded at once: one navigation, not the bundled page followed by the server. Everything else
//! starts on the bundled page (`ui/`), and so does a server that does not load: [`guard`] sends
//! the window back there, where `connect` and the "unreachable" screen take over as before.

use std::future::Future;
use std::time::Duration;

use tauri::{Url, WebviewUrl};
use tokio::sync::watch;

/// How long the server's page has to finish loading before the window goes back to the bundled
/// page; the same wait the bundled page gives it (`ui/local.js`, `connect`).
pub const LOAD_LIMIT: Duration = Duration::from_secs(20);

/// What the window opens on. The server on this computer waits for its stack to start, so it opens
/// the bundled page, which follows that start; so does no chosen server.
pub fn window_url(server: Option<&Url>, this_computer: bool) -> WebviewUrl {
    match server {
        Some(server) if !this_computer => WebviewUrl::External(server.clone()),
        _ => WebviewUrl::App("index.html".into()),
    }
}

/// Waits for the server's first page, which `loaded` reports, and calls `give_up` when it does not
/// come. A server whose probe (`reachable`) fails gives up at once, even when something has loaded:
/// behind a proxy the probe fails while the web view gets through, and the bundled page then
/// shows its screen and is replaced by the page that arrives, as it always was. Otherwise the
/// page has `limit` from the start.
pub async fn guard(
    probe: impl Future<Output = bool>,
    mut loaded: watch::Receiver<bool>,
    limit: Duration,
    give_up: impl FnOnce(),
) {
    let started = tokio::time::Instant::now();
    if !probe.await {
        return give_up();
    }
    let left = limit.saturating_sub(started.elapsed());
    if tokio::time::timeout(left, loaded.wait_for(|loaded| *loaded))
        .await
        .is_err()
    {
        give_up();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{Verdict, decide_with};
    use std::sync::atomic::{AtomicBool, Ordering};

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn a_chosen_remote_server_is_the_first_page() {
        let server = url("https://dozo.example.com/");
        assert_eq!(
            window_url(Some(&server), false),
            WebviewUrl::External(server.clone())
        );
        // A server on this computer that was picked by hand is a server like any other.
        let loopback = url("http://127.0.0.1:5173/");
        assert_eq!(
            window_url(Some(&loopback), false),
            WebviewUrl::External(loopback)
        );
    }

    #[test]
    fn every_other_case_opens_the_bundled_page() {
        let bundled = WebviewUrl::App("index.html".into());
        // None chosen yet.
        assert_eq!(window_url(None, false), bundled);
        // The server on this computer waits for its stack, whatever address was saved for it.
        assert_eq!(window_url(None, true), bundled);
        let saved = url("http://127.0.0.1:8123/");
        assert_eq!(window_url(Some(&saved), true), bundled);
    }

    #[test]
    fn the_first_page_is_one_the_window_lets_in() {
        for server in ["https://dozo.example.com/", "http://localhost:5173/"] {
            let server = url(server);
            assert_eq!(
                decide_with(&server, Some(&server), None),
                Verdict::Window,
                "{server}"
            );
        }
    }

    /// The page of a server must not gain the app's commands by being the window's first page: no
    /// capability may name a remote origin, the same rule `README.md` ("Security") states.
    #[test]
    fn no_capability_reaches_a_remote_page() {
        let mut seen = 0;
        for entry in
            std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities")).unwrap()
        {
            let path = entry.unwrap().path();
            let text = std::fs::read_to_string(&path).unwrap();
            let capability: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert!(capability.get("remote").is_none(), "{}", path.display());
            assert!(capability["windows"].is_array(), "{}", path.display());
            seen += 1;
        }
        assert!(seen >= 4);
    }

    const SHORT: Duration = Duration::from_millis(60);

    /// Runs the guard and says whether it gave up.
    async fn gave_up(probe: bool, loaded_after: Option<Duration>) -> bool {
        let (sender, receiver) = watch::channel(false);
        if let Some(after) = loaded_after {
            tokio::spawn(async move {
                tokio::time::sleep(after).await;
                sender.send_replace(true);
            });
        } else {
            // Kept open: a page that never finishes is not a closed channel.
            std::mem::forget(sender);
        }
        let called = AtomicBool::new(false);
        guard(async move { probe }, receiver, SHORT, || {
            called.store(true, Ordering::SeqCst);
        })
        .await;
        called.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn a_page_that_loads_in_time_is_left_alone() {
        assert!(!gave_up(true, Some(Duration::from_millis(5))).await);
        // Already loaded before the probe answered.
        assert!(!gave_up(true, Some(Duration::ZERO)).await);
    }

    #[tokio::test]
    async fn a_page_that_never_loads_goes_back_to_the_bundled_page_after_the_limit() {
        let begun = std::time::Instant::now();
        assert!(gave_up(true, None).await);
        assert!(begun.elapsed() >= SHORT);
        // Too late is never.
        assert!(gave_up(true, Some(SHORT * 20)).await);
    }

    #[tokio::test]
    async fn an_unreachable_server_goes_back_at_once() {
        let begun = std::time::Instant::now();
        assert!(gave_up(false, None).await);
        assert!(begun.elapsed() < SHORT);
        // Even a page the web view got through to (a proxy): the bundled page's own flow
        // loads it again and replaces its screen when it arrives.
        assert!(gave_up(false, Some(Duration::ZERO)).await);
    }
}
