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

/// How long a page has to commit after the probe failed. The probe ignores a system proxy, so
/// behind one it fails on every launch while the page loads; a page that commits within this is
/// left alone. A server that is really down gives up this long after the probe's own answer.
pub const COMMIT_GRACE: Duration = Duration::from_secs(2);

/// What the window opens on. The server on this computer waits for its stack to start, so it opens
/// the bundled page, which follows that start; so does no chosen server.
pub fn window_url(server: Option<&Url>, this_computer: bool) -> WebviewUrl {
    match server {
        Some(server) if !this_computer => WebviewUrl::External(server.clone()),
        _ => WebviewUrl::App("index.html".into()),
    }
}

/// Where the window's first page has got to, as the web view reports it, and whether the person
/// (or the app) has since sent the window elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Load {
    /// No document of the page is committed. A load that failed stays here too: the web view says
    /// nothing of a failure.
    Waiting,
    /// The page's document started to arrive (`PageLoadEvent::Started`): the load is progressing.
    Committed,
    /// The page finished (`PageLoadEvent::Finished`).
    Finished,
    /// The window was sent to a screen of the app on purpose (Change Server, a reload that starts
    /// over). Set when that navigation is asked for, not read back from the page's address.
    Away,
}

impl Load {
    /// The state once `event` happened. It never goes back, and `Away` is final: a page that
    /// finishes after the window was sent away does not take the first page back.
    pub fn after(self, event: Load) -> Load {
        match (self, event) {
            (Load::Away, _) | (_, Load::Away) => Load::Away,
            (Load::Finished, _) | (_, Load::Finished) => Load::Finished,
            (Load::Committed, _) | (_, Load::Committed) => Load::Committed,
            _ => Load::Waiting,
        }
    }
}

/// The window's first page as the app holds it: what the web view reports and what the app asks of
/// the window (`report`), read by [`guard`].
pub struct FirstLoad(watch::Sender<Load>);

impl Default for FirstLoad {
    fn default() -> Self {
        Self(watch::channel(Load::Waiting).0)
    }
}

impl FirstLoad {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn watch(&self) -> watch::Receiver<Load> {
        self.0.subscribe()
    }

    pub fn report(&self, event: Load) {
        self.0.send_if_modified(|load| {
            let next = load.after(event);
            let changed = next != *load;
            *load = next;
            changed
        });
    }

    /// Takes the right to send the window back to the bundled page: true only if the page is still
    /// `Waiting`, and it is `Away` from then on. One step, so a Change Server that lands after the
    /// guard's timeout fired but before it acts finds the window taken, or is found by it.
    pub fn claim(&self) -> bool {
        self.0.send_if_modified(|load| {
            let waiting = *load == Load::Waiting;
            if waiting {
                *load = Load::Away;
            }
            waiting
        })
    }
}

/// Watches the server's first page and calls `give_up` when it does not come, which sends the
/// window back to the bundled page. It gives up only while no document has been committed:
/// - the probe (`reachable`) passed: the page has `limit` from the start to commit;
/// - the probe failed: the page has `grace` to commit. Behind a proxy the probe fails while the
///   web view gets through, so a page that commits is left alone.
///
/// A page that is arriving is never cancelled, however slow: the bundled page's flow would load it
/// a second time. And it stands down for good once the window is sent away (`Load::Away`).
pub async fn guard(
    probe: impl Future<Output = bool>,
    mut state: watch::Receiver<Load>,
    limit: Duration,
    grace: Duration,
    give_up: impl FnOnce(),
) {
    let started = tokio::time::Instant::now();
    let wait = if probe.await {
        limit.saturating_sub(started.elapsed())
    } else {
        grace
    };
    if tokio::time::timeout(wait, state.wait_for(|load| *load != Load::Waiting))
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

    const SHORT: Duration = Duration::from_millis(80);
    const GRACE: Duration = Duration::from_millis(20);
    const NOW: Duration = Duration::ZERO;
    const SOON: Duration = Duration::from_millis(5);

    /// Runs the guard while the web view reports each `(after, state)` in turn; says whether it
    /// gave up and how long it took.
    async fn run(probe: bool, events: &[(Duration, Load)]) -> (bool, Duration) {
        let (sender, receiver) = watch::channel(Load::Waiting);
        let events = events.to_vec();
        let feeder = tokio::spawn(async move {
            for (after, event) in events {
                tokio::time::sleep(after).await;
                sender.send_modify(|load| *load = load.after(event));
            }
            // Kept open: a page that never arrives is not a closed channel.
            std::future::pending::<()>().await;
        });
        let called = AtomicBool::new(false);
        let begun = std::time::Instant::now();
        guard(async move { probe }, receiver, SHORT, GRACE, || {
            called.store(true, Ordering::SeqCst);
        })
        .await;
        let took = begun.elapsed();
        feeder.abort();
        (called.load(Ordering::SeqCst), took)
    }

    // The guard's timeout and a Change Server can land in either order; whoever comes second finds
    // the window taken.
    #[test]
    fn the_window_is_taken_once_and_never_from_a_window_sent_away() {
        let first = FirstLoad::new();
        let page = first.watch();
        assert!(first.claim());
        assert_eq!(*page.borrow(), Load::Away);
        assert!(!first.claim());
        let sent_away = FirstLoad::new();
        sent_away.report(Load::Away);
        assert!(!sent_away.claim());
        let arriving = FirstLoad::new();
        arriving.report(Load::Committed);
        assert!(!arriving.claim());
    }

    #[test]
    fn the_state_only_moves_forward_and_away_is_final() {
        use Load::*;
        assert_eq!(Waiting.after(Committed), Committed);
        assert_eq!(Committed.after(Finished), Finished);
        assert_eq!(Finished.after(Committed), Finished);
        assert_eq!(Committed.after(Waiting), Committed);
        for state in [Waiting, Committed, Finished, Away] {
            assert_eq!(state.after(Away), Away);
            assert_eq!(Away.after(state), Away);
        }
    }

    #[tokio::test]
    async fn a_page_that_loads_in_time_is_left_alone() {
        let loads = [(SOON, Load::Committed), (SOON, Load::Finished)];
        assert!(!run(true, &loads).await.0);
        assert!(!run(true, &[(NOW, Load::Finished)]).await.0);
    }

    // The old flow kept loading behind its "unreachable" screen: a slow server still opened.
    #[tokio::test]
    async fn a_slow_page_that_is_arriving_is_not_cancelled_at_the_limit() {
        // Committed, and not finished until well past the limit.
        let loads = [(SOON, Load::Committed), (SHORT * 10, Load::Finished)];
        let (gave_up, took) = run(true, &loads).await;
        assert!(!gave_up);
        assert!(took < SHORT, "it stands down when the page commits");
        // Same when the probe failed (a proxy) and the page commits within the grace.
        assert!(!run(false, &[(SOON, Load::Committed)]).await.0);
    }

    #[tokio::test]
    async fn a_page_that_never_commits_goes_back_to_the_bundled_page_after_the_limit() {
        let (gave_up, took) = run(true, &[]).await;
        assert!(gave_up);
        assert!(took >= SHORT);
        // Committing too late is too late.
        assert!(run(true, &[(SHORT * 10, Load::Committed)]).await.0);
    }

    #[tokio::test]
    async fn an_unreachable_server_goes_back_within_the_grace() {
        let (gave_up, took) = run(false, &[]).await;
        assert!(gave_up);
        assert!(took >= GRACE && took < SHORT);
    }

    // Behind a proxy the probe fails every time while the page loads fine: it must not be dropped
    // for the bundled page, which would load the server a second time.
    #[tokio::test]
    async fn a_failed_probe_does_not_drop_a_page_that_loaded() {
        assert!(!run(false, &[(NOW, Load::Finished)]).await.0);
        let loads = [(NOW, Load::Committed), (SOON, Load::Finished)];
        assert!(!run(false, &loads).await.0);
    }

    // Change Server asked for within the first seconds: the form must stay.
    #[tokio::test]
    async fn a_window_sent_away_is_left_alone() {
        assert!(!run(true, &[(SOON, Load::Away)]).await.0);
        assert!(!run(false, &[(NOW, Load::Away)]).await.0);
        // Also when the page finishes afterwards.
        assert!(
            !run(true, &[(NOW, Load::Away), (SOON, Load::Finished)])
                .await
                .0
        );
    }
}
