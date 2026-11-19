//! Automatic updates. At launch and once a day the app asks the release manifest
//! (`plugins.updater` in tauri.conf.json) for a newer version, downloads it in the background and
//! keeps it only when its signature checks out against the public key built into the app. Then one
//! menu item offers to restart into it; nothing installs until the user picks it. A failure of
//! any step goes to `updates.log` in the app's log folder and changes nothing.

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

/// The menu item's id.
pub const MENU_ID: &str = "update";

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
/// downloaded and verified.
pub fn watch(app: AppHandle, ready: fn(&AppHandle)) {
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
                        ready(&app);
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
/// app and starts it again itself.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let Some((update, bytes)) = app.state::<Pending>().0.lock().unwrap().take() else {
        return;
    };
    match update.install(&bytes) {
        Ok(()) => app.restart(),
        Err(error) => log(
            app,
            &format!("install of {} failed: {error}", update.version),
        ),
    }
}

fn log<R: Runtime>(app: &AppHandle<R>, line: &str) {
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_secs());
    // Nowhere else to report it: an update that fails must not interrupt the user.
    let _ = std::fs::create_dir_all(&dir).and_then(|()| {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("updates.log"))?;
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

    #[test]
    fn the_menu_line_is_turkish_on_a_turkish_system() {
        assert_eq!(label(Some("tr-TR")), "Güncellemek için yeniden başlat");
        assert_eq!(label(Some("en-US")), "Restart to Update");
        assert_eq!(label(None), "Restart to Update");
    }
}
