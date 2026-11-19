//! Dozo for macOS, Windows and Linux: a native window around the Dozo web app. What it does and leaves
//! out: README.md.
// A release build on Windows opens no console window beside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod frames;
#[cfg(target_os = "linux")]
#[path = "frames_gtk.rs"]
mod frames;
mod server;

use std::time::{Duration, Instant};
use std::{fs, path::PathBuf, process::Command, sync::Mutex};

use server::{LOCAL, Verdict, decide, hook_verdict, is_local, outside, parse_server, reachable};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::{
    AppHandle, Manager, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
    window::Color,
};

/// The server the user chose. Only its origin loads in the window.
struct Server(Mutex<Option<Url>>);

fn chosen(app: &AppHandle) -> Option<Url> {
    app.state::<Server>().0.lock().unwrap().clone()
}

fn server_file(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("server"))
}

#[tauri::command]
fn current_server(app: AppHandle) -> Option<String> {
    chosen(&app).map(String::from)
}

/// Checks and saves the address. The error is the sentence the form shows.
#[tauri::command]
fn set_server(app: AppHandle, address: String) -> Result<String, String> {
    let server = parse_server(&address)?;
    let file = server_file(&app).map_err(|error| error.to_string())?;
    fs::create_dir_all(file.parent().unwrap_or(&file))
        .and_then(|()| fs::write(&file, server.as_str()))
        .map_err(|error| format!("Could not save the address: {error}"))?;
    *app.state::<Server>().0.lock().unwrap() = Some(server.clone());
    Ok(server.into())
}

/// Starts loading the chosen server and says whether it looks reachable. The local screen stays
/// until the server's page arrives, so a load that fails leaves that screen, not a blank page.
/// The load starts either way: behind a proxy the probe fails while the web view gets through.
#[tauri::command]
async fn connect(window: WebviewWindow) -> bool {
    let Some(server) = chosen(window.app_handle()) else {
        return false;
    };
    let probe = server.clone();
    window.navigate(server).is_ok()
        && tauri::async_runtime::spawn_blocking(move || reachable(&probe))
            .await
            .unwrap_or(false)
}

/// Hands a link to the default browser or mail app.
// ponytail: at most one a second, so a page that navigates in a loop cannot flood the browser.
// A second link clicked within that second is dropped; count per gesture if that ever bites.
fn open_outside(url: Url) {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap();
    if last.is_some_and(|at| at.elapsed() < Duration::from_secs(1)) {
        return;
    }
    *last = Some(Instant::now());
    // Waited for on its own thread so the finished `open` is reaped.
    std::thread::spawn(move || opener().arg(url.as_str()).status());
}

#[cfg(target_os = "macos")]
fn opener() -> Command {
    Command::new("/usr/bin/open")
}

/// The shell's handler for a web or mail address. The address is one argument and no command
/// interpreter reads it.
#[cfg(windows)]
fn opener() -> Command {
    let mut command = Command::new("rundll32");
    command.arg("url.dll,FileProtocolHandler");
    command
}

/// The desktop's handler for a web or mail address, as one argument.
#[cfg(target_os = "linux")]
fn opener() -> Command {
    Command::new("xdg-open")
}

/// Acts on a verdict: true when the address loads in the window.
fn follow(verdict: Verdict) -> bool {
    match verdict {
        Verdict::Window => true,
        Verdict::Browser(url) => {
            open_outside(url);
            false
        }
        Verdict::Refused => false,
    }
}

fn show_local(window: &WebviewWindow, query: &str) {
    let _ = window.navigate(Url::parse(&format!("{LOCAL}{query}")).expect("a constant URL"));
}

/// Reloads the server's page in place. A server that stopped answering would leave a failed
/// page, so that case (and a reload of a local screen) starts over from the local screen.
fn reload(window: WebviewWindow) {
    let on_server = window.url().is_ok_and(|url| !is_local(&url));
    let server = chosen(window.app_handle()).filter(|_| on_server);
    tauri::async_runtime::spawn_blocking(move || match server {
        Some(server) if reachable(&server) => {
            let _ = window.reload();
        }
        _ => show_local(&window, ""),
    });
}

#[cfg(target_os = "macos")]
fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let separator = || PredefinedMenuItem::separator(app);
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Dozo",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &separator()?,
                    &MenuItem::with_id(
                        app,
                        "change-server",
                        "Change Server…",
                        true,
                        Some("Cmd+,"),
                    )?,
                    &separator()?,
                    &PredefinedMenuItem::services(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &MenuItem::with_id(app, "reload", "Reload", true, Some("Cmd+R"))?,
                    &separator()?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
        ],
    )
}

/// Windows and Linux draw the menu inside the window, and the web view has the editing shortcuts
/// itself: one short menu.
#[cfg(not(target_os = "macos"))]
fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    Menu::with_items(
        app,
        &[&Submenu::with_items(
            app,
            "Dozo",
            true,
            &[
                &MenuItem::with_id(app, "change-server", "Change Server…", true, Some("Ctrl+,"))?,
                &MenuItem::with_id(app, "reload", "Reload", true, Some("Ctrl+R"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?],
    )
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            current_server,
            set_server,
            connect
        ])
        .menu(menu)
        .on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            match event.id().as_ref() {
                "change-server" => show_local(&window, "?change"),
                "reload" => reload(window),
                _ => {}
            }
        })
        .setup(|app| {
            let app = app.handle().clone();
            // A saved address is checked again: the file may have been edited by hand.
            let saved = fs::read_to_string(server_file(&app)?)
                .ok()
                .and_then(|address| parse_server(&address).ok());
            app.manage(Server(Mutex::new(saved)));

            let window =
                WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
                    .title("Dozo")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(420.0, 520.0)
                    .theme(Some(Theme::Dark))
                    .background_color(Color(20, 20, 20, 255))
                    .on_navigation({
                        let app = app.clone();
                        move |url| follow(hook_verdict(url, chosen(&app).as_ref()))
                    })
                    // The app has one window: a link that asks for a new one goes to the browser.
                    .on_new_window(|url, _| {
                        if let Some(url) = outside(&url) {
                            open_outside(url);
                        }
                        NewWindowResponse::Deny
                    })
                    // Downloads go to the Downloads folder under a name that is not taken.
                    .on_download(|_, _| true)
                    // Camera, microphone and the like: the web view grants them unless told otherwise.
                    .on_permission_request(|_, _| PermissionResponse::Deny)
                    .build()?;
            // Only macOS and Linux need the gate: the Windows web view asks the navigation hook
            // about the window's own page alone, so frames load there as they do in a browser.
            #[cfg(target_os = "macos")]
            frames::only_gate_the_main_frame(&window)?;
            #[cfg(target_os = "linux")]
            frames::only_gate_the_main_frame(&window, move |url| {
                follow(decide(url, chosen(&app).as_ref()))
            })?;
            #[cfg(windows)]
            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the app failed to start");
}
