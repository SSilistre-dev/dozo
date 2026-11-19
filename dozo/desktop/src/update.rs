//! Automatic updates. At launch and once a day the app asks the release manifest
//! (`plugins.updater` in tauri.conf.json) for a newer version, downloads it in the background and
//! keeps it only when its signature checks out against the public key built into the app. Then one
//! menu item offers to restart into it; nothing installs until the user picks it. A failure of
//! any step goes to `updates.log` in the app's log folder and changes nothing.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

/// The menu item's id.
pub const MENU_ID: &str = "update";
/// The id of the one-item menu that holds it, so it is added once.
pub const MENU_HOLDER_ID: &str = "update-menu";
/// The log is cut to a fresh file past this size, keeping one older file.
const LOG_LIMIT: u64 = 64 * 1024;

/// A downloaded update whose signature checked out, waiting for the user.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

/// The one line the menu shows, in the system's language where we have it.
pub fn label(locale: Option<&str>) -> &'static str {
    match locale {
        Some(locale) if locale.to_ascii_lowercase().starts_with("tr") => {
            "Güncellemek için yeniden başlat"
        }
        _ => "Restart to Update",
    }
}

/// Checks now and then once a day, on a thread of its own. `ready` runs once an update is
/// downloaded and verified and says whether it could be offered; one that could not is dropped,
/// so the next check runs.
pub fn watch(app: AppHandle, ready: fn(&AppHandle) -> bool) {
    const DAY: Duration = Duration::from_secs(24 * 60 * 60);
    std::thread::spawn(move || {
        let mut last: Option<SystemTime> = None;
        loop {
            // Wall-clock time, so a day spent asleep still counts as a day.
            let due = last.is_none_or(|at| at.elapsed().unwrap_or(DAY) >= DAY);
            let waiting = app.state::<Pending>().0.lock().unwrap().is_some();
            if due && !waiting {
                last = Some(SystemTime::now());
                match app
                    .updater()
                    .map_err(|error| error.to_string())
                    .and_then(|updater| {
                        tauri::async_runtime::block_on(fetch(&updater))
                            .map_err(|error| error.to_string())
                    }) {
                    Ok(Some(found)) => {
                        log(&app, &format!("downloaded {}", found.0.version));
                        *app.state::<Pending>().0.lock().unwrap() = Some(found);
                        if !ready(&app) {
                            app.state::<Pending>().0.lock().unwrap().take();
                            log(&app, "no menu to offer it in");
                        }
                    }
                    Ok(None) => {}
                    Err(error) => log(&app, &format!("check failed: {error}")),
                }
            }
            std::thread::sleep(Duration::from_secs(60 * 60));
        }
    });
}

/// A newer version and its package, if there is one. The download fails, and nothing is kept,
/// when the signature does not verify or was made for another version than the manifest names.
pub async fn fetch(updater: &Updater) -> tauri_plugin_updater::Result<Option<(Update, Vec<u8>)>> {
    let Some(update) = updater.check().await? else {
        return Ok(None);
    };
    let bytes = update.download(|_, _| {}, || {}).await?;
    Ok(Some((update, bytes)))
}

/// Installs the waiting update and starts the new version. On Windows the installer closes the
/// app and starts it again itself. A failed install (a refused password, a folder the app cannot
/// write) keeps the update waiting, so the menu still works and the user can try again.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    match install_waiting(&app.state::<Pending>()) {
        Some(Ok(())) => app.restart(),
        Some(Err(error)) => log(app, &error),
        None => {}
    }
}

fn install_waiting(pending: &Pending) -> Option<Result<(), String>> {
    let mut waiting = pending.0.lock().unwrap();
    let (update, bytes) = waiting.as_ref()?;
    if let Err(error) = update.install(bytes) {
        return Some(Err(format!(
            "install of {} failed: {error}",
            update.version
        )));
    }
    *waiting = None;
    Some(Ok(()))
}

fn log<R: Runtime>(app: &AppHandle<R>, line: &str) {
    if let Ok(dir) = app.path().app_log_dir() {
        append(&dir, line);
    }
}

fn append(dir: &Path, line: &str) {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_secs());
    let file = dir.join("updates.log");
    // Nowhere else to report it: an update that fails must not interrupt the user.
    let _ = std::fs::create_dir_all(dir).and_then(|()| {
        if file.metadata().is_ok_and(|meta| meta.len() > LOG_LIMIT) {
            std::fs::rename(&file, dir.join("updates.old.log"))?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&file)?;
        writeln!(file, "{at} {line}")
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
    use tauri::{App, Url};
    use tauri_plugin_updater::Error;

    const PAYLOAD: &[u8] = include_bytes!("update_fixtures/payload");
    /// Made with `cargo tauri signer sign --app-version 0.2.0` and a test key nothing else uses.
    const SIGNATURE: &str = include_str!("update_fixtures/payload.sig");
    const TEST_PUBKEY: &str = include_str!("update_fixtures/test.pub");

    /// Serves `manifest` at /latest.json and `payload` at /payload on a local port.
    fn serve(manifest: String, payload: Vec<u8>) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let manifest = manifest.replace("BASE/", &base);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut request = String::new();
                let mut reader = BufReader::new(&mut stream);
                reader.read_line(&mut request).unwrap();
                // Headers end at the first empty line; requests here have no body.
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap() > 2 {
                    line.clear();
                }
                let body = if request.contains("/payload") {
                    payload.clone()
                } else {
                    manifest.clone().into_bytes()
                };
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        Url::parse(&base).unwrap().join("latest.json").unwrap()
    }

    fn manifest(version: &str, signature: &str) -> String {
        let target = tauri_plugin_updater::target().unwrap();
        serde_json::json!({
            "version": version,
            "platforms": { target: { "url": "BASE/payload", "signature": signature } }
        })
        .to_string()
    }

    /// An app at version 0.1.0 with the updater settings of tauri.conf.json, except for the test
    /// key and the local manifest.
    fn app() -> App<MockRuntime> {
        let real: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut settings = real["plugins"]["updater"].clone();
        settings["pubkey"] = TEST_PUBKEY.into();
        let mut context = mock_context(noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), settings);
        mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap()
    }

    fn fetch_from(
        manifest: String,
        payload: &[u8],
    ) -> tauri_plugin_updater::Result<Option<String>> {
        let app = app();
        let endpoint = serve(manifest, payload.to_vec());
        let updater = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .unwrap()
            .build()
            .unwrap();
        tauri::async_runtime::block_on(fetch(&updater))
            .map(|found| found.map(|(update, _)| update.version))
    }

    #[test]
    fn only_a_newer_version_is_an_update() {
        assert_eq!(app().package_info().version.to_string(), "0.1.0");
        assert_eq!(
            fetch_from(manifest("0.2.0", SIGNATURE), PAYLOAD).unwrap(),
            Some("0.2.0".into())
        );
        for same_or_older in ["0.1.0", "0.0.9", "0.1.0-beta.1"] {
            assert_eq!(
                fetch_from(manifest(same_or_older, SIGNATURE), PAYLOAD).unwrap(),
                None,
                "{same_or_older}"
            );
        }
    }

    #[test]
    fn a_package_that_does_not_match_its_signature_is_refused() {
        let mut tampered = PAYLOAD.to_vec();
        tampered[0] ^= 1;
        assert!(matches!(
            fetch_from(manifest("0.2.0", SIGNATURE), &tampered),
            Err(Error::Minisign(_))
        ));
        assert!(matches!(
            fetch_from(manifest("0.2.0", "not a signature"), PAYLOAD),
            Err(Error::Base64(_))
        ));
    }

    /// What latest-json.sh guards against: a line break after the signature breaks it.
    #[test]
    fn a_signature_with_a_trailing_line_break_does_not_verify() {
        let signature = format!("{SIGNATURE}\n");
        assert!(fetch_from(manifest("0.2.0", &signature), PAYLOAD).is_err());
    }

    #[test]
    fn a_signature_made_for_another_version_is_refused() {
        // Signed as 0.2.0: a manifest cannot pass it off as 0.3.0.
        assert!(matches!(
            fetch_from(manifest("0.3.0", SIGNATURE), PAYLOAD),
            Err(Error::SignedVersionMismatch { .. })
        ));
    }

    #[test]
    fn the_app_key_and_manifest_are_the_release_ones() {
        let real: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let settings = &real["plugins"]["updater"];
        assert_eq!(
            settings["endpoints"],
            serde_json::json!([
                "https://github.com/SSilistre-dev/dozo/releases/latest/download/latest.json"
            ])
        );
        assert_eq!(settings["requireSignedVersion"], true);
        assert_ne!(settings["pubkey"], TEST_PUBKEY);
    }

    /// A real update whose package cannot install: the test payload is not an AppImage. Only on
    /// Linux, where that is found before anything is written; elsewhere install runs an installer.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_failed_install_keeps_the_update_waiting() {
        let app = app();
        let endpoint = serve(manifest("0.2.0", SIGNATURE), PAYLOAD.to_vec());
        let updater = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .unwrap()
            .build()
            .unwrap();
        let found = tauri::async_runtime::block_on(fetch(&updater)).unwrap();
        let pending = Pending(Mutex::new(found));
        for _ in 0..2 {
            let error = install_waiting(&pending).unwrap().unwrap_err();
            assert!(error.starts_with("install of 0.2.0 failed"), "{error}");
            assert!(pending.0.lock().unwrap().is_some());
        }
        assert!(install_waiting(&Pending::default()).is_none());
    }

    #[test]
    fn the_log_keeps_one_older_file_past_its_limit() {
        let dir = std::env::temp_dir().join(format!("dozo-update-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        append(&dir, "first");
        std::fs::write(dir.join("updates.log"), vec![b'x'; LOG_LIMIT as usize + 1]).unwrap();
        append(&dir, "next");
        let log = std::fs::read_to_string(dir.join("updates.log")).unwrap();
        assert!(
            log.ends_with(" next\n") && log.lines().count() == 1,
            "{log}"
        );
        assert!(
            std::fs::metadata(dir.join("updates.old.log"))
                .unwrap()
                .len()
                > LOG_LIMIT
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_menu_line_is_turkish_on_a_turkish_system() {
        assert_eq!(label(Some("tr-TR")), "Güncellemek için yeniden başlat");
        assert_eq!(label(Some("en-US")), "Restart to Update");
        assert_eq!(label(None), "Restart to Update");
    }
}
