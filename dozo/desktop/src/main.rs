//! Dozo for macOS, Windows and Linux: a native window around the Dozo web app. What it does and leaves
//! out: README.md.
// A release build on Windows opens no console window beside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alerts;
mod background;
#[cfg(target_os = "macos")]
mod frames;
#[cfg(target_os = "linux")]
#[path = "frames_gtk.rs"]
mod frames;
mod server;
mod settings;
mod update;

use std::time::{Duration, Instant};
use std::{fs, path::PathBuf, process::Command, sync::Mutex};

use background::{Close, OS};
use server::{LOCAL, Verdict, decide, is_local, outside, parse_server, reachable};
use settings::Settings;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    Wry, window::Color,
};
use tauri_plugin_autostart::ManagerExt;

const MENU_ID: &str = "dozo-menu";
const OPEN_AT_LOGIN_ID: &str = "open-at-login";
const KEEP_RUNNING_ID: &str = "keep-running";

/// What the user chose: the server (only its origin loads in the window) and the two switches.
struct Config(Mutex<Settings>);

fn chosen(app: &AppHandle) -> Option<Url> {
    app.state::<Config>().0.lock().unwrap().server.clone()
}

fn settings_file(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("server"))
}

/// Saves what the user chose, as it is when this turn comes: changes made at the same moment on
/// other threads are written in order, and the choices themselves are never locked while the
/// file is written.
fn persist(app: &AppHandle) -> Result<(), String> {
    static TURN: Mutex<()> = Mutex::new(());
    let _turn = TURN.lock().unwrap();
    let snapshot = app.state::<Config>().0.lock().unwrap().clone();
    let file = settings_file(app).map_err(|error| error.to_string())?;
    settings::save(&file, &snapshot).map_err(|error| error.to_string())
}

/// The file that says the app is restarting for an update, and so must open its window.
fn restart_marker(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("restarted"))
}

/// Restart to Update. The new process gets the old one's arguments, the login entry's among
/// them, and must still show its window: the marker says so, and is gone once it has been read
/// (or here, when the install failed and the app stays).
fn restart_for_update(app: &AppHandle) {
    let marker = restart_marker(app);
    if let Some(file) = &marker {
        let _ = fs::create_dir_all(file.parent().unwrap_or(file));
        let _ = fs::write(file, "");
    }
    update::install(app);
    if let Some(file) = marker {
        let _ = fs::remove_file(file);
    }
}

#[tauri::command]
fn current_server(app: AppHandle) -> Option<String> {
    chosen(&app).map(String::from)
}

/// Checks and saves the address. The error is the sentence the form shows.
#[tauri::command]
fn set_server(app: AppHandle, address: String) -> Result<String, String> {
    let server = parse_server(&address)?;
    let previous = app
        .state::<Config>()
        .0
        .lock()
        .unwrap()
        .server
        .replace(server.clone());
    persist(&app).map_err(|error| {
        app.state::<Config>().0.lock().unwrap().server = previous;
        format!("Could not save the address: {error}")
    })?;
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
            &Submenu::with_id_and_items(
                app,
                MENU_ID,
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
                    &switch(app, OPEN_AT_LOGIN_ID, "Open at Login")?,
                    &switch(app, KEEP_RUNNING_ID, "Keep Running in Background")?,
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
        &[&Submenu::with_id_and_items(
            app,
            MENU_ID,
            "Dozo",
            true,
            &[
                &MenuItem::with_id(app, "change-server", "Change Server…", true, Some("Ctrl+,"))?,
                &MenuItem::with_id(app, "reload", "Reload", true, Some("Ctrl+R"))?,
                &PredefinedMenuItem::separator(app)?,
                &switch(app, OPEN_AT_LOGIN_ID, "Open at Login")?,
                &switch(app, KEEP_RUNNING_ID, "Keep Running in Background")?,
                &PredefinedMenuItem::separator(app)?,
                // Ends the app whatever the window does, and does not depend on the menu
                // toolkit's own handling of a quit item.
                &MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?,
            ],
        )?],
    )
}

#[cfg(not(target_os = "macos"))]
const QUIT_ID: &str = "quit";

/// A switch in the menu; it starts off and `show_switches` sets it once the saved choice is read.
fn switch(app: &AppHandle, id: &str, label: &str) -> tauri::Result<CheckMenuItem<Wry>> {
    CheckMenuItem::with_id(app, id, label, true, false, None::<&str>)
}

fn switch_item(app: &AppHandle, id: &str) -> Option<CheckMenuItem<Wry>> {
    match app.menu()?.get(MENU_ID)? {
        MenuItemKind::Submenu(menu) => match menu.get(id)? {
            MenuItemKind::Check(item) => Some(item),
            _ => None,
        },
        _ => None,
    }
}

fn show_switches(app: &AppHandle, settings: &Settings) {
    for (id, on) in [
        (OPEN_AT_LOGIN_ID, settings.open_at_login),
        (KEEP_RUNNING_ID, settings.keep_running),
    ] {
        if let Some(item) = switch_item(app, id) {
            let _ = item.set_checked(on);
        }
    }
}

/// The user picked a switch: the item has already flipped, so it holds the new choice. The login
/// entry is the system's, so what it ends up as is what the menu and the file show.
fn flip(app: &AppHandle, id: &str) {
    let Some(item) = switch_item(app, id) else {
        return;
    };
    let wanted = item.is_checked().unwrap_or(false);
    let config = &app.state::<Config>().0;
    if id == OPEN_AT_LOGIN_ID {
        let login = app.autolaunch();
        let changed = if wanted {
            login.enable()
        } else {
            login.disable()
        };
        if let Err(error) = &changed {
            eprintln!("dozo: could not change the login entry: {error}");
        }
        let known = config.lock().unwrap().open_at_login;
        let actual = login.is_enabled().unwrap_or(known);
        let _ = item.set_checked(actual);
        config.lock().unwrap().open_at_login = actual;
    } else {
        config.lock().unwrap().keep_running = wanted;
    }
    if let Err(error) = persist(app) {
        eprintln!("dozo: could not save the choice: {error}");
    }
}

/// Brings the window back: shown, restored from the taskbar and in front.
fn reveal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The tray icon is the way back to a hidden window on Windows and Linux. Linux draws it only
/// when something on the desktop hosts tray icons (GNOME needs an extension for it), so that is
/// asked too; without a host the icon exists but nobody can click it.
#[cfg(not(target_os = "macos"))]
fn tray_showing(app: &AppHandle) -> bool {
    app.try_state::<tauri::tray::TrayIcon>().is_some() && tray_host()
}

#[cfg(windows)]
fn tray_host() -> bool {
    true
}

#[cfg(target_os = "linux")]
fn tray_host() -> bool {
    use webkit2gtk::gio::{self, Cancellable};
    use webkit2gtk::glib::ToVariant;
    gio::bus_get_sync(gio::BusType::Session, Cancellable::NONE)
        .and_then(|bus| {
            bus.call_sync(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
                "NameHasOwner",
                Some(&("org.kde.StatusNotifierWatcher",).to_variant()),
                None,
                gio::DBusCallFlags::NONE,
                1000,
                Cancellable::NONE,
            )
        })
        .ok()
        .and_then(|reply| reply.child_value(0).get::<bool>())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn tray_showing(_: &AppHandle) -> bool {
    false
}

fn can_reopen(app: &AppHandle) -> bool {
    background::can_reopen(OS, tray_showing(app))
}

#[cfg(not(target_os = "macos"))]
const TRAY_OPEN_ID: &str = "tray-open";
#[cfg(not(target_os = "macos"))]
const TRAY_UPDATE_ID: &str = "tray-update";

/// The tray's menu, kept so the update item can be added to it once one is waiting.
#[cfg(not(target_os = "macos"))]
struct TrayMenu(Menu<Wry>);

/// Adds the update item to the top of the tray's menu, once: with the window hidden it is the only
/// way to restart into an update. Runs on the main thread.
#[cfg(not(target_os = "macos"))]
fn offer_update_in_tray(app: &AppHandle, label: &str) {
    let (Some(menu), Some(tray)) = (app.try_state::<TrayMenu>(), app.tray_by_id("dozo")) else {
        return;
    };
    if menu.0.get(TRAY_UPDATE_ID).is_some() {
        return;
    }
    let added = MenuItem::with_id(app, TRAY_UPDATE_ID, label, true, None::<&str>)
        .and_then(|item| menu.0.insert(&item, 0))
        .and_then(|()| tray.set_menu(Some(menu.0.clone())));
    if let Err(error) = added {
        eprintln!("dozo: could not show the update item in the tray: {error}");
    }
}

/// Adds the tray icon: Open Dozo and Quit Dozo, and a click shows the window. A failure leaves
/// the app without one, which `can_reopen` then reports.
#[cfg(not(target_os = "macos"))]
fn add_tray(app: &AppHandle) {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let built = (|| -> tauri::Result<()> {
        let menu = Menu::with_items(
            app,
            &[
                &MenuItem::with_id(app, TRAY_OPEN_ID, "Open Dozo", true, None::<&str>)?,
                &MenuItem::with_id(app, "tray-quit", "Quit Dozo", true, None::<&str>)?,
            ],
        )?;
        app.manage(TrayMenu(menu.clone()));
        let mut tray = TrayIconBuilder::with_id("dozo")
            .tooltip("Dozo")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                TRAY_OPEN_ID => reveal(app),
                TRAY_UPDATE_ID => restart_for_update(app),
                "tray-quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    reveal(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        app.manage(tray.build(app)?);
        Ok(())
    })();
    if let Err(error) = built {
        eprintln!("dozo: no tray icon: {error}");
    }
}

/// Shows the one menu item that restarts into a downloaded update: a menu of that one item at
/// the end of the menu bar, whose title says the same. A macOS menu bar takes only menus, and a
/// plain item in a GTK menu bar is never activated. Says whether it is shown; it is added once.
fn offer_update(app: &AppHandle) -> bool {
    let (shown, answer) = std::sync::mpsc::channel();
    let handle = app.clone();
    let asked = app.run_on_main_thread(move || {
        let app = &handle;
        let Some(menu) = app.menu() else {
            let _ = shown.send(false);
            return;
        };
        if menu.get(update::MENU_HOLDER_ID).is_some() {
            let _ = shown.send(true);
            return;
        }
        let label = update::label(sys_locale::get_locale().as_deref());
        #[cfg(not(target_os = "macos"))]
        offer_update_in_tray(app, label);
        let added = MenuItem::with_id(app, update::MENU_ID, label, true, None::<&str>)
            .and_then(|item| {
                Submenu::with_id_and_items(app, update::MENU_HOLDER_ID, label, true, &[&item])
            })
            .and_then(|holder| menu.append(&holder));
        if let Err(error) = &added {
            eprintln!("dozo: could not show the update item: {error}");
        }
        let _ = shown.send(added.is_ok());
    });
    asked.is_ok() && answer.recv().unwrap_or(false)
}

fn main() {
    tauri::Builder::default()
        // First: a second launch hands over to the running app before anything else starts, and
        // the running app shows its window, hidden or not. A login start never does.
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !background::from_login(&args) {
                reveal(app);
            }
        }))
        // Whether the window is shown is decided here, not restored: a window hidden when the
        // app last ended must not make the next start hidden.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Dozo")
                .arg(background::LOGIN_ARG)
                .build(),
        )
        .manage(update::Pending::default())
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
                OPEN_AT_LOGIN_ID | KEEP_RUNNING_ID => flip(app, event.id().as_ref()),
                #[cfg(not(target_os = "macos"))]
                QUIT_ID => app.exit(0),
                update::MENU_ID => restart_for_update(app),
                _ => {}
            }
        })
        .setup(|app| {
            let app = app.handle().clone();
            let mut settings = fs::read_to_string(settings_file(&app)?)
                .map(|text| settings::parse(&text))
                .unwrap_or_default();
            // The login entry is the system's and the user may have removed it from outside:
            // what it says now is what the menu shows.
            let saved = settings.open_at_login;
            if let Ok(actual) = app.autolaunch().is_enabled() {
                settings.open_at_login = actual;
            }
            if settings.open_at_login != saved
                && let Err(error) = settings::save(&settings_file(&app)?, &settings)
            {
                eprintln!("dozo: could not save the login entry: {error}");
            }
            show_switches(&app, &settings);
            app.manage(Config(Mutex::new(settings.clone())));
            #[cfg(not(target_os = "macos"))]
            add_tray(&app);
            update::watch(app.clone(), offer_update);
            // Read once and gone, so only the start right after Restart to Update sees it.
            let restarted = restart_marker(&app).is_some_and(|file| fs::remove_file(file).is_ok());
            let hidden = background::start_hidden(
                background::from_login(std::env::args()),
                restarted,
                settings.keep_running,
                can_reopen(&app),
            );

            let window =
                WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
                    .title("Dozo")
                    .visible(!hidden)
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(420.0, 520.0)
                    .theme(Some(Theme::Dark))
                    .background_color(Color(20, 20, 20, 255))
                    .on_navigation({
                        let app = app.clone();
                        move |url| follow(decide(url, chosen(&app).as_ref()))
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
                    // Notifications for the server's own origin; camera, microphone and the
                    // like are refused (the web view grants them unless told otherwise).
                    .on_permission_request({
                        let app = app.clone();
                        move |webview, kind| {
                            alerts::answer(kind, webview.url().ok().as_ref(), chosen(&app).as_ref())
                        }
                    })
                    // The server's page puts its unread count in front of its title; nothing
                    // else of it reaches the app, and any other page counts as none. The window
                    // keeps its own title.
                    .on_document_title_changed({
                        let app = app.clone();
                        move |window, title| {
                            let page = window.url().ok();
                            let count =
                                alerts::count_for(page.as_ref(), chosen(&app).as_ref(), &title);
                            alerts::show_unread(&window, count);
                        }
                    })
                    // Leaving the server (Change Server, the connection screens) clears the badge
                    // at once, whether or not the next page's title changes.
                    .on_page_load({
                        let app = app.clone();
                        move |window, load| {
                            if !alerts::on_server(Some(load.url()), chosen(&app).as_ref()) {
                                alerts::show_unread(&window, 0);
                            }
                        }
                    })
                    .build()?;
            window.on_window_event({
                let app = app.clone();
                move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let keep = app.state::<Config>().0.lock().unwrap().keep_running;
                        let Some(window) = app.get_webview_window("main") else {
                            return;
                        };
                        match background::on_close(keep, can_reopen(&app)) {
                            Close::Quit => {}
                            Close::Hide => {
                                api.prevent_close();
                                let _ = window.hide();
                            }
                            Close::Minimize => {
                                api.prevent_close();
                                let _ = window.minimize();
                            }
                        }
                    }
                }
            });
            // Only macOS and Linux need the gate: the Windows web view asks the navigation hook
            // about the window's own page alone, so frames load there as they do in a browser.
            #[cfg(target_os = "macos")]
            frames::only_gate_the_main_frame(&window)?;
            #[cfg(target_os = "linux")]
            alerts::reveal_on_click(&window)?;
            #[cfg(target_os = "linux")]
            frames::only_gate_the_main_frame(&window, move |url, seen| {
                follow(frames::verdict(url, chosen(&app).as_ref(), seen))
            })?;
            #[cfg(windows)]
            let _ = window;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the app failed to start")
        .run(|app, event| {
            // The Dock icon was clicked while the window was hidden.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                reveal(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
