//! Back Up… and Restore… in the Dozo menu, for the server on this computer: a small window asks
//! the password (twice when backing up), the system's file dialog picks the file, and the
//! bundle's command does the work (`stack_backup.rs`). The window's page (`ui/backup.html`) only
//! ever sees the file's name: the path stays here, and the password goes on to the command's
//! standard input. The items are on only while that server runs.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_dialog::DialogExt;

use crate::server::is_local;
use crate::stack::Status;
use crate::stack_backup::{self, Refusal, Tool};
use crate::stack_setup;
use crate::{LocalServer, local_layout, local_options};

pub const BACK_UP_ID: &str = "back-up";
pub const RESTORE_ID: &str = "restore";
const WINDOW: &str = "backup";
const EXTENSION: &str = "dozobackup";
const SHORT: &str = "Use at least 8 characters.";

/// The two menu items, kept to switch them on and off.
pub struct Items(pub MenuItem<Wry>, pub MenuItem<Wry>);

/// The file picked for a restore, until its password comes.
#[derive(Default)]
pub struct Picked(Mutex<Option<PathBuf>>);

pub fn items(app: &AppHandle) -> tauri::Result<(MenuItem<Wry>, MenuItem<Wry>)> {
    let back_up = MenuItem::with_id(app, BACK_UP_ID, "Back Up…", false, None::<&str>)?;
    let restore = MenuItem::with_id(app, RESTORE_ID, "Restore…", false, None::<&str>)?;
    app.manage(Items(back_up.clone(), restore.clone()));
    app.manage(Picked::default());
    Ok((back_up, restore))
}

/// Keeps the items in step with the server on this computer.
pub fn follow(app: AppHandle) {
    let local = app.state::<LocalServer>().0.clone();
    let mut status = local.status();
    tauri::async_runtime::spawn(async move {
        loop {
            let on = matches!(*status.borrow_and_update(), Status::Ready(_));
            if let Some(items) = app.try_state::<Items>() {
                let _ = items.0.set_enabled(on);
                let _ = items.1.set_enabled(on);
            }
            if status.changed().await.is_err() {
                return;
            }
        }
    });
}

/// Opens the window for `mode` (`backup` or `restore`), or brings it forward in that mode.
pub fn open(app: &AppHandle, mode: &str) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
    let page = format!("backup.html?{mode}");
    let title = if mode == "restore" {
        "Restore"
    } else {
        "Back Up"
    };
    let built = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(340.0, 360.0)
        .resizable(false)
        .center()
        .on_navigation(is_local)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    match built {
        Ok(window) => {
            #[cfg(not(target_os = "macos"))]
            let _ = window.remove_menu();
            #[cfg(target_os = "macos")]
            let _ = window;
        }
        Err(error) => eprintln!("dozo: could not open {title}: {error}"),
    }
}

fn tool(app: &AppHandle) -> Result<Tool, String> {
    let layout = local_layout(app).map_err(|error| error.to_string())?;
    Tool::of(&layout.0).ok_or_else(|| "Update the server first.".to_owned())
}

/// Backs up into a file the person picks; `false` when they cancelled the picker.
#[tauri::command]
pub async fn back_up(app: AppHandle, password: String) -> Result<bool, String> {
    if password.chars().count() < 8 {
        return Err(SHORT.into());
    }
    let tool = tool(&app)?;
    let dialog = app
        .dialog()
        .file()
        .set_file_name(format!("Dozo {}.{EXTENSION}", today()))
        .add_filter("Dozo backup", &[EXTENSION]);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .ok()
        .flatten();
    let Some(file) = picked.and_then(|file| file.into_path().ok()) else {
        return Ok(false);
    };
    tool.create(&file, &password)
        .await
        .map_err(|refusal| refusal.message().to_owned())?;
    Ok(true)
}

/// Picks the backup to restore; its name, or nothing when cancelled.
#[tauri::command]
pub async fn restore_pick(app: AppHandle) -> Option<String> {
    let dialog = app.dialog().file().add_filter("Dozo backup", &[EXTENSION]);
    let file = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .ok()??
        .into_path()
        .ok()?;
    let name = file.file_name()?.to_string_lossy().into_owned();
    *app.state::<Picked>().0.lock().unwrap() = Some(file);
    Some(name)
}

/// Restores the picked backup in place of what this computer has: the server stops, its data
/// goes aside, the backup comes in, the server starts on it. Anything that fails on the way puts
/// the data back as it was and starts the server again.
#[tauri::command]
pub async fn restore(app: AppHandle, password: String) -> Result<(), String> {
    let file = app
        .state::<Picked>()
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or("Choose a backup first.")?;
    let tool = tool(&app)?;
    let layout = local_layout(&app).map_err(|error| error.to_string())?;
    let local = app.state::<LocalServer>().0.clone();
    local.stop().await;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    // Nothing else may start a server on this folder meanwhile.
    let Some(held) = hold(&layout.0).await else {
        local.start(layout, local_options(&app)).await;
        return Err(Refusal::Failed.message().into());
    };
    let restored = tool.restore(&file, &password, stamp).await;
    drop(held);
    let started = |local: std::sync::Arc<crate::stack::Local>| {
        let (app, layout) = (app.clone(), layout.clone());
        async move {
            local.start(layout, local_options(&app)).await;
            let mut status = local.status();
            let settled =
                status.wait_for(|status| matches!(status, Status::Ready(_) | Status::Failed(_)));
            matches!(
                tokio::time::timeout(Duration::from_secs(600), settled)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .as_deref(),
                Some(Status::Ready(_))
            )
        }
    };
    let message = match restored {
        Err(refusal) => {
            started(local.clone()).await;
            return Err(format!("{} Nothing changed.", refusal.message()));
        }
        Ok(aside) => {
            if started(local.clone()).await {
                None
            } else {
                // A backup whose server does not start here: back to what there was.
                local.stop().await;
                let held = hold(&layout.0).await;
                let undone = stack_backup::undo_restore(&layout.0, &aside, stamp + 1);
                drop(held);
                started(local.clone()).await;
                Some(match undone {
                    Ok(()) => "The restored server did not start, so the data is back as it was.",
                    Err(_) => Refusal::Failed.message(),
                })
            }
        }
    };
    *app.state::<Picked>().0.lock().unwrap() = None;
    // The main window signs in again on the restored server (its secrets changed).
    if let Some(window) = app.get_webview_window("main") {
        crate::show_local(&window, "");
    }
    match message {
        None => Ok(()),
        Some(message) => Err(message.to_owned()),
    }
}

async fn hold(root: &std::path::Path) -> Option<std::fs::File> {
    for _ in 0..30 {
        if let Ok(Some(lock)) = stack_setup::lock(&root.join("stack.lock")) {
            return Some(lock);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

/// Today as `YYYY-MM-DD`, for the file's name.
fn today() -> String {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs() / 86_400) as i64;
    date(days)
}

/// The civil date `days` after 1970-01-01 (Howard Hinnant's algorithm).
fn date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_is_named_after_the_day() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(20_412), "2025-11-20");
        assert_eq!(date(11_016), "2000-02-29");
    }
}
