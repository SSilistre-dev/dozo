//! The server on this computer end to end, with the real bundle and without a window (part of
//! `stack.rs`'s tests): `tests/stack_e2e.sh` runs these on Linux in Docker, and the workflow
//! `dozo-server-bundle` on Windows (`tests/stack_e2e_windows.ps1`). Each is ignored in a plain
//! test run: it needs a built bundle and a local manifest.

use super::*;

/// The real bundle, end to end, without a window: `tests/stack_e2e.sh` runs this with
/// `DOZO_STACK_E2E_MANIFEST` (a local manifest) and `DOZO_STACK_E2E_ROOT` (an empty folder).
/// Installs, starts, checks `/health`, stops, and checks no process of it is left.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a built server bundle; run by tests/stack_e2e.sh"]
async fn e2e_installs_starts_and_stops_the_real_server() {
    let (local, root, ports) = e2e_ready().await;
    assert!(answers_200(ports.api, "/health"));
    e2e_this_computer_connects(&root, ports).await;
    assert!(local.stop().await, "a process had to be killed");
    let left = left_after_stop(&root);
    assert!(left.is_empty(), "still running after stop: {left:?}");
    println!("E2E: stopped, no process left");
}

/// Starts the real server and waits to be killed (`tests/stack_e2e.sh` kills it with
/// SIGKILL, then checks that every process of the server ended with it).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a built server bundle; run by tests/stack_e2e.sh"]
async fn e2e_hold_until_killed() {
    let (_local, _root, _ports) = e2e_ready().await;
    println!("E2E: holding");
    tokio::time::sleep(Duration::from_secs(600)).await;
}

/// A phone pairs through the relay agent in the real bundle: `tests/stack_e2e.sh` runs a dev
/// relay and a phone (`tests/relay_phone.mts`) beside it, sharing `DOZO_STACK_E2E_SHARED`.
/// The code goes there; the phone pairs, fetches a page of this server through the relay and
/// says what it got. Then the phone is listed, removed, and the server stopped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a built server bundle and a relay; run by tests/stack_e2e.sh"]
async fn e2e_pairs_a_phone() {
    let shared = PathBuf::from(std::env::var("DOZO_STACK_E2E_SHARED").unwrap());
    let relay = std::env::var("DOZO_STACK_E2E_RELAY").unwrap();
    let port: u16 = relay.rsplit(':').next().unwrap().parse().unwrap();
    assert!(
        wait_until(Duration::from_secs(120), move || {
            TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_ok()
        })
        .await,
        "no relay at {relay}"
    );
    let (local, root, _) = e2e_ready().await;
    let mut events = local.phone_events();
    let agent = local.agent().await.expect("the bundle has the relay agent");
    let offer = agent.offer().await.unwrap();
    // The offer works once the agent's socket for it is open.
    let log = root.join("logs/relay.log");
    let connected = format!(r#""event":"connected","channel":"{}""#, offer.channel);
    assert!(
        wait_until(Duration::from_secs(30), move || {
            fs::read_to_string(&log).is_ok_and(|text| text.contains(&connected))
        })
        .await,
        "the agent never connected the new channel"
    );
    fs::write(shared.join("qr"), &offer.qr).unwrap();
    let channel = offer.channel.clone();
    // `paired`, or already the question that follows it (`keep_phone_event`).
    let heard = events.wait_for(|event| {
        event.as_ref().is_some_and(|event| {
            (event["event"] == "paired" || event["event"] == "approval")
                && event_channel(event) == Some(channel.as_str())
        })
    });
    tokio::time::timeout(Duration::from_secs(60), heard)
        .await
        .expect("the phone never paired")
        .unwrap();
    println!("E2E: a phone paired on {}", offer.channel);
    let fetched = shared.join("fetched");
    assert!(
        wait_until(Duration::from_secs(30), move || fetched.exists()).await,
        "the phone never said what it fetched"
    );
    let fetched = fs::read_to_string(shared.join("fetched")).unwrap();
    assert_eq!(
        fetched.trim(),
        "200",
        "the phone's request through the relay"
    );
    println!(
        "E2E: the phone fetched a page through the relay: {}",
        fetched.trim()
    );
    // The phone asks for its sign-in: the window would show the code, which the person
    // compares with the phone's, and allow it.
    let channel = offer.channel.clone();
    let asked = events.wait_for(|event| {
        event.as_ref().is_some_and(|event| {
            event["event"] == "approval" && event_channel(event) == Some(channel.as_str())
        })
    });
    let asked = tokio::time::timeout(Duration::from_secs(60), asked)
        .await
        .expect("the phone never asked for its sign-in")
        .unwrap()
        .clone()
        .unwrap();
    let shown = fs::read_to_string(shared.join("code")).unwrap();
    assert_eq!(
        asked["code"].as_str(),
        Some(shown.trim()),
        "the codes differ"
    );
    assert_eq!(asked["platform"], "android");
    println!("E2E: the phone asks to sign in, same code on both ends");
    agent.approve(&offer.channel).await.unwrap();
    let signed_in = shared.join("signed-in");
    assert!(
        wait_until(Duration::from_secs(30), move || signed_in.exists()).await,
        "the phone never got its sign-in"
    );
    let signed_in = fs::read_to_string(shared.join("signed-in")).unwrap();
    assert_eq!(signed_in.trim(), "200 owner@example.test");
    println!("E2E: allowed here, the phone signed in as owner@example.test");
    let listed = agent.phones().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].channel, offer.channel);
    agent.remove(&offer.channel).await.unwrap();
    assert!(agent.phones().await.unwrap().is_empty());
    println!("E2E: listed and removed the phone");
    assert!(local.stop().await, "a process had to be killed");
    let left = left_after_stop(&root);
    assert!(left.is_empty(), "still running after stop: {left:?}");
    println!("E2E: stopped, relay agent included, no process left");
}

/// Sign-in with the hosted account, as the window does it: the server on this computer runs
/// with `HOSTED_LOGIN_ISSUER` (`DOZO_STACK_E2E_ISSUER`, `tests/fake_issuer.mjs`); its sign-in
/// starts, the issuer's page (which the window may open) sends back to the callback (which it
/// may open too), and the session that comes back is the hosted account's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a built server bundle and a stand-in issuer; run by tests/stack_e2e.sh"]
async fn e2e_signs_in_with_the_hosted_account() {
    use crate::server::{Verdict, decide_with};
    let issuer = tauri::Url::parse(&std::env::var("DOZO_STACK_E2E_ISSUER").unwrap()).unwrap();
    let (local, root, ports) = e2e_ready().await;
    let web = tauri::Url::parse(&format!("http://127.0.0.1:{}/", ports.web)).unwrap();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let cookies = |response: &reqwest::Response| {
        response
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|value| value.to_str().ok()?.split(';').next().map(str::to_owned))
            .collect::<Vec<_>>()
            .join("; ")
    };
    // The local sign-in page's button.
    let start = client
        .post(web.join("/api/auth/dozo/hosted-login/start").unwrap())
        .header("origin", web.as_str().trim_end_matches('/'))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(start.status(), 200, "start");
    let nonce = cookies(&start);
    let page: Value = start.json().await.unwrap();
    let page = tauri::Url::parse(page["url"].as_str().unwrap()).unwrap();
    assert_eq!(page.origin(), issuer.origin());
    assert_eq!(
        decide_with(&page, Some(&web), Some(&issuer)),
        Verdict::Window
    );
    // The issuer's page agrees at once and sends the window back.
    let agreed = client.get(page.clone()).send().await.unwrap();
    assert_eq!(agreed.status(), 302, "the issuer's page");
    let back = tauri::Url::parse(agreed.headers()["location"].to_str().unwrap()).unwrap();
    assert_eq!(
        decide_with(&back, Some(&web), Some(&issuer)),
        Verdict::Window
    );
    let callback = client
        .get(back)
        .header("cookie", &nonce)
        .send()
        .await
        .unwrap();
    assert_eq!(callback.status(), 302, "the callback");
    assert_eq!(
        callback.headers()["location"].to_str().unwrap(),
        web.as_str()
    );
    let session = cookies(&callback);
    let me: Value = client
        .get(web.join("/api/auth/get-session").unwrap())
        .header("cookie", session)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me["user"]["email"], "owner@example.test", "{me}");
    println!("E2E: signed in as the hosted account through the stand-in issuer");
    // Every other way to sign in is closed on such a server.
    let password = client
        .post(web.join("/api/auth/sign-in/email").unwrap())
        .header("origin", web.as_str().trim_end_matches('/'))
        .header("content-type", "application/json")
        .body(r#"{"email":"owner@example.test","password":"x"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(password.status(), 404, "password sign-in");
    assert!(local.stop().await, "a process had to be killed");
    let left = left_after_stop(&root);
    assert!(left.is_empty(), "still running after stop: {left:?}");
    println!("E2E: stopped, no process left");
}

/// As `e2e_hold_until_killed`, but started as on a system where nothing ends the server's
/// processes with the app (macOS): after the SIGKILL they keep running.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a built server bundle; run by tests/stack_e2e.sh"]
async fn e2e_hold_as_on_macos_until_killed() {
    crate::stack_os::AS_WITHOUT_PDEATHSIG.store(true, std::sync::atomic::Ordering::SeqCst);
    let (_local, _root, _ports) = e2e_ready().await;
    println!("E2E: holding");
    tokio::time::sleep(Duration::from_secs(600)).await;
}

/// The next start after that: it ends what was left, then starts as usual, and stops clean.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a built server bundle; run by tests/stack_e2e.sh"]
async fn e2e_ends_what_a_crashed_app_left() {
    let root = PathBuf::from(std::env::var("DOZO_STACK_E2E_ROOT").unwrap());
    assert!(
        !processes_under(&root).is_empty(),
        "nothing was left to end"
    );
    let (local, root, ports) = e2e_ready().await;
    assert!(answers_200(ports.api, "/health"));
    let events = fs::read_to_string(root.join("logs/manager.log")).unwrap();
    let ended = events
        .matches("ended a process left from an earlier start")
        .count();
    assert!(ended >= 4, "{events}");
    println!("E2E: ended {ended} processes left by the killed app, then started");
    assert!(local.stop().await, "a process had to be killed");
    let left = left_after_stop(&root);
    assert!(left.is_empty(), "still running after stop: {left:?}");
    println!("E2E: stopped, no process left");
}

/// Updating the real server (`tests/stack_e2e.sh`, step 5): installed from the older bundle
/// with an account, it updates to the newer one at the next start and the account still
/// signs in; a newer version that cannot start (its Node is broken) puts it back as it was,
/// and the start after that runs the version that works without trying again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs two built server bundles; run by tests/stack_e2e.sh"]
async fn e2e_updates_and_goes_back() {
    let root = PathBuf::from(std::env::var("DOZO_STACK_E2E_ROOT").unwrap());
    let options = |variable: &str| Options {
        manifest: std::env::var(variable).unwrap(),
        hosted_login_issuer: None,
        relay: String::new(),
        expected: None,
    };
    let local = Local::new(Arc::new(RealChecks));
    let account = async |path: &str| {
        let ports = stack_setup::saved_ports(&root.join("ports")).unwrap();
        let web = format!("http://127.0.0.1:{}", ports.web);
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::new()
            .post(format!("{web}{path}"))
            .header("origin", &web)
            .header("content-type", "application/json")
            .body(
                r#"{"email":"owner@example.test","password":"update-Password-123","name":"Owner"}"#,
            )
            .send()
            .await
            .unwrap()
            .status()
    };
    let current = || fs::read_to_string(root.join("current")).unwrap();
    let started = std::time::Instant::now();

    local
        .start(Layout(root.clone()), options("DOZO_STACK_E2E_OLD_MANIFEST"))
        .await;
    assert!(matches!(settled_for(&local, 180).await, Status::Ready(_)));
    let old = current();
    assert_eq!(account("/api/auth/sign-up/email").await, 200);
    assert!(local.stop().await);
    println!(
        "E2E: installed {old} with an account ({} ms)",
        started.elapsed().as_millis()
    );

    let started = std::time::Instant::now();
    let mut seen = local.status();
    local
        .start(Layout(root.clone()), options("DOZO_STACK_E2E_MANIFEST"))
        .await;
    let mut updating = false;
    while !matches!(
        *seen.borrow_and_update(),
        Status::Ready(_) | Status::Failed(_)
    ) {
        updating |= *seen.borrow() == Status::Updating;
        tokio::time::timeout(Duration::from_secs(180), seen.changed())
            .await
            .unwrap()
            .unwrap();
    }
    assert!(
        matches!(*seen.borrow(), Status::Ready(_)),
        "{:?}",
        seen.borrow()
    );
    assert!(updating);
    let new = current();
    assert_ne!(new, old);
    assert_eq!(
        account("/api/auth/sign-in/email").await,
        200,
        "the account after the update"
    );
    assert!(local.stop().await);
    println!(
        "E2E: updated {old} to {new}, the account signs in ({} ms)",
        started.elapsed().as_millis()
    );

    local
        .start(
            Layout(root.clone()),
            options("DOZO_STACK_E2E_BROKEN_MANIFEST"),
        )
        .await;
    assert_eq!(
        settled_for(&local, 180).await,
        Status::Failed(Failure::UpdateRolledBack)
    );
    assert_eq!(current(), new);
    println!(
        "E2E: a broken newer version was put back: {:?}",
        Failure::UpdateRolledBack.message()
    );
    local
        .start(
            Layout(root.clone()),
            options("DOZO_STACK_E2E_BROKEN_MANIFEST"),
        )
        .await;
    assert!(matches!(settled_for(&local, 120).await, Status::Ready(_)));
    assert_eq!(current(), new);
    assert_eq!(
        account("/api/auth/sign-in/email").await,
        200,
        "the account after going back"
    );
    assert!(local.stop().await);
    let left = left_after_stop(&root);
    assert!(left.is_empty(), "still running after stop: {left:?}");
    println!("E2E: started {new} again without retrying, the account signs in, no process left");
}

/// Back up and restore with the real bundle's command (`tests/stack_e2e.sh`, step 6), on the
/// server step 5 left: a backup of the running server; a file added after it; a restore with
/// the wrong password changes nothing; one with the right password brings the backup's state
/// back over the data in use, and the account still signs in.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a built server bundle with the backup command; run by tests/stack_e2e.sh"]
async fn e2e_backs_up_and_restores() {
    use crate::stack_backup::{Refusal, Tool};
    let root = PathBuf::from(std::env::var("DOZO_STACK_E2E_ROOT").unwrap());
    let options = Options {
        manifest: std::env::var("DOZO_STACK_E2E_MANIFEST").unwrap(),
        hosted_login_issuer: None,
        relay: String::new(),
        expected: None,
    };
    let local = Local::new(Arc::new(RealChecks));
    let sign_in = async || {
        let ports = stack_setup::saved_ports(&root.join("ports")).unwrap();
        let web = format!("http://127.0.0.1:{}", ports.web);
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::new()
            .post(format!("{web}/api/auth/sign-in/email"))
            .header("origin", &web)
            .header("content-type", "application/json")
            .body(r#"{"email":"owner@example.test","password":"update-Password-123"}"#)
            .send()
            .await
            .unwrap()
            .status()
    };
    local.start(Layout(root.clone()), options.clone()).await;
    assert!(matches!(settled_for(&local, 180).await, Status::Ready(_)));
    let tool = Tool::of(&root).expect("the bundle has the backup command");
    let file = root.with_file_name("e2e.dozobackup");
    let started = std::time::Instant::now();
    tool.create(&file, "backup-Password-1").await.unwrap();
    println!(
        "E2E: backed up the running server ({} KB, {} ms)",
        fs::metadata(&file).unwrap().len() / 1024,
        started.elapsed().as_millis()
    );
    fs::write(root.join("data/after-the-backup"), "new").unwrap();
    assert!(local.stop().await);

    assert_eq!(
        tool.restore(&file, "not-the-password", 1).await,
        Err(Refusal::WrongPassword)
    );
    assert!(
        root.join("data/after-the-backup").exists(),
        "a refused restore changed nothing"
    );
    println!("E2E: the wrong password was refused, nothing changed");

    let started = std::time::Instant::now();
    tool.restore(&file, "backup-Password-1", 2).await.unwrap();
    assert!(!root.join("data/after-the-backup").exists());
    assert!(
        root.join("before-restore/2-0/data/after-the-backup")
            .exists()
    );
    local.start(Layout(root.clone()), options).await;
    assert!(matches!(settled_for(&local, 180).await, Status::Ready(_)));
    assert_eq!(sign_in().await, 200, "the account after the restore");
    println!(
        "E2E: restored over the data in use ({} ms), the account signs in",
        started.elapsed().as_millis()
    );
    assert!(local.stop().await);
    let left = left_after_stop(&root);
    assert!(left.is_empty(), "still running after stop: {left:?}");
}

async fn settled_for(local: &Local, seconds: u64) -> Status {
    let mut status = local.status();
    let wait = status.wait_for(|status| matches!(status, Status::Ready(_) | Status::Failed(_)));
    tokio::time::timeout(Duration::from_secs(seconds), wait)
        .await
        .unwrap()
        .unwrap()
        .clone()
}

async fn e2e_ready() -> (Arc<Local>, PathBuf, Ports) {
    exit_on_panic();
    let root = PathBuf::from(std::env::var("DOZO_STACK_E2E_ROOT").unwrap());
    let options = Options {
        manifest: std::env::var("DOZO_STACK_E2E_MANIFEST").unwrap(),
        hosted_login_issuer: std::env::var("DOZO_STACK_E2E_ISSUER").ok(),
        relay: std::env::var("DOZO_STACK_E2E_RELAY").unwrap_or_default(),
        expected: None,
    };
    let local = Local::new(Arc::new(RealChecks));
    let started = std::time::Instant::now();
    let mut seen = local.status();
    local.start(Layout(root.clone()), options).await;
    let status = loop {
        let status = seen.borrow_and_update().clone();
        println!("E2E: {:?} at {} ms", status, started.elapsed().as_millis());
        if matches!(status, Status::Ready(_) | Status::Failed(_)) {
            break status;
        }
        seen.changed().await.unwrap();
    };
    let Status::Ready(url) = status else {
        panic!("did not start: {status:?}; see {}/logs", root.display());
    };
    println!(
        "E2E: ready {url} after {} ms",
        started.elapsed().as_millis()
    );
    let ports = stack_setup::saved_ports(&root.join("ports")).unwrap();
    (local, root, ports)
}

/// "Let Bots Use This Computer" against this server: sign up, pair with the app's own pairing
/// code, connect with its socket, and see the server list this computer as connected.
async fn e2e_this_computer_connects(root: &Path, ports: Ports) {
    use crate::device_pairing::{Outcome, Pairing, Secrets as Keys, SignIn};
    struct Keyring(Mutex<std::collections::HashMap<String, String>>);
    impl Keys for Keyring {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }
    struct Cookie(String);
    impl SignIn for Cookie {
        async fn cookies(&self, _: &tauri::Url) -> Option<String> {
            Some(self.0.clone())
        }
    }
    let web = tauri::Url::parse(&format!("http://127.0.0.1:{}/", ports.web)).unwrap();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::new();
    let signup = client
        .post(web.join("/api/auth/sign-up/email").unwrap())
        .header("content-type", "application/json")
        .header("origin", web.as_str().trim_end_matches('/'))
        .body(r#"{"email":"owner@example.test","password":"e2e-Password-123","name":"Owner"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(signup.status(), 200, "sign-up");
    let cookie = signup
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok()?.split(';').next().map(str::to_owned))
        .collect::<Vec<_>>()
        .join("; ");
    let pairing = Pairing::new(
        web.clone(),
        root.join("e2e-devices"),
        Arc::new(Keyring(Mutex::default())),
    );
    pairing.allow().unwrap();
    let outcome = pairing.pair(&Cookie(cookie.clone())).await;
    let Ok(Outcome::Connected(token)) = outcome else {
        panic!("pairing: {outcome:?}");
    };
    println!("E2E: paired this computer");
    let (stop, stopped) = watch::channel(false);
    let options = crate::device_socket::Options {
        server: web.clone(),
        token,
        runner: crate::device_run::Runner::new(root.join("e2e-computers"), root.to_owned()),
        retry: (Duration::from_millis(200), Duration::from_secs(2)),
        grace: Duration::from_secs(1),
    };
    let socket = tokio::spawn(crate::device_socket::run(options, stopped));
    let devices = web.join("/api/devices").unwrap();
    let connected = wait_until(Duration::from_secs(20), move || {
        let list = std::process::Command::new("curl")
            .args(["-fsS", "-H", &format!("cookie: {cookie}"), devices.as_str()])
            .output();
        list.is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains(r#""connected":true"#))
    })
    .await;
    let _ = stop.send(true);
    let _ = socket.await;
    assert!(
        connected,
        "the server never listed this computer as connected"
    );
    println!("E2E: this computer connected over the device socket");
}

/// A failed check ends the test process at once, after its message. Unwinding would wait for
/// the server's output to end, which on Windows is read on threads the runtime waits for, while
/// the server runs on until this process ends (its job objects close with it).
fn exit_on_panic() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let report = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            report(info);
            std::process::exit(101);
        }));
    });
}

/// What is still running from the server's folder a few seconds after a stop: a stop waits for
/// each process it started, while what those started ends a moment later.
fn left_after_stop(root: &Path) -> Vec<String> {
    let mut left = processes_under(root);
    for _ in 0..50 {
        if left.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
        left = processes_under(root);
    }
    left
}

/// Processes whose program or command line is in the server's folder.
#[cfg(unix)]
fn processes_under(root: &Path) -> Vec<String> {
    let root = root.to_string_lossy().into_owned();
    let me = std::process::id().to_string();
    fs::read_dir("/proc")
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().unwrap().to_string_lossy();
            name.chars().all(|c| c.is_ascii_digit()) && name != me
        })
        .filter_map(|path| {
            let program = fs::read_link(path.join("exe")).unwrap_or_default();
            let cmdline = fs::read(path.join("cmdline")).unwrap_or_default();
            let cmdline = String::from_utf8_lossy(&cmdline).replace('\0', " ");
            (program.starts_with(&root) || cmdline.contains(&root))
                .then(|| format!("{}: {cmdline}", path.display()))
        })
        .collect()
}

/// The same on Windows, from the system's process list (paths compared without case).
#[cfg(windows)]
fn processes_under(root: &Path) -> Vec<String> {
    let root = root.to_string_lossy().to_lowercase();
    let me = std::process::id().to_string();
    let listed = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }",
        ])
        .output()
        .expect("the process list");
    String::from_utf8_lossy(&listed.stdout)
        .lines()
        .filter(|line| {
            let mut fields = line.splitn(3, '\t');
            let pid = fields.next().unwrap_or_default();
            pid != me && fields.any(|field| field.to_lowercase().contains(&root))
        })
        .map(str::to_owned)
        .collect()
}
