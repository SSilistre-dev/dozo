//! Push to Talk: a shortcut that works while another app is in front. Held down, it brings the
//! window forward and starts the server page's own dictation, as its microphone button does;
//! let go, it sends what was heard. The app has no bridge into the page: it dispatches one window
//! event on the server's page and reads nothing back. What each system does: README.md, "Push to
//! Talk".

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

pub const MENU_ID: &str = "push-to-talk";

/// The menu item's label, which names the shortcut: a menu accelerator would also make it a
/// shortcut of the menu, which would flip the switch instead of talking.
#[cfg(target_os = "macos")]
pub const LABEL: &str = "Push to Talk (⇧⌘Space)";
#[cfg(not(target_os = "macos"))]
pub const LABEL: &str = "Push to Talk (Ctrl+Shift+Space)";

/// The shortcut's keys as the message about a refused one, and the web app's section, name them.
#[cfg(target_os = "macos")]
pub const KEYS: &str = "⇧⌘Space";
#[cfg(not(target_os = "macos"))]
pub const KEYS: &str = "Ctrl+Shift+Space";

pub fn shortcut() -> Shortcut {
    let command = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    Shortcut::new(Some(command | Modifiers::SHIFT), Code::Space)
}

/// The window event the page's composer listens for (`TALK_KEY_EVENT` in
/// `apps/web/src/components/composer/dozo-hold-to-talk.ts`).
pub fn script(down: bool) -> String {
    let detail = if down { "down" } else { "up" };
    format!("window.dispatchEvent(new CustomEvent('dozo-talk-key', {{ detail: '{detail}' }}))")
}

/// Why the shortcut cannot be used here before trying, or None. A Wayland desktop gives an app
/// no global shortcut it can grab: registering one through X11 succeeds and then never fires
/// while a Wayland app is in front, which would fail silently.
pub fn unavailable(wayland_display: Option<&str>, gdk_backend: Option<&str>) -> Option<String> {
    let wayland = wayland_display.is_some_and(|display| !display.is_empty())
        && !gdk_backend
            .is_some_and(|backends| backends.split(',').next().map(str::trim) == Some("x11"));
    (cfg!(target_os = "linux") && wayland).then(|| {
        "This desktop does not let apps use a shortcut while another app is in front, so Push to \
         Talk stays off."
            .to_owned()
    })
}

/// What the person is told when the system refuses the shortcut.
pub fn taken() -> String {
    format!("{KEYS} is already used by another app, so Push to Talk stays off.")
}

/// Turns the shortcut on or off. On: Err carries what to tell the person, and nothing is
/// registered.
pub fn set(app: &AppHandle, on: bool) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    let shortcut = shortcut();
    if !on {
        if shortcuts.is_registered(shortcut) {
            shortcuts
                .unregister(shortcut)
                .map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    if let Some(reason) = unavailable(
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("GDK_BACKEND").ok().as_deref(),
    ) {
        return Err(reason);
    }
    if shortcuts.is_registered(shortcut) {
        return Ok(());
    }
    shortcuts.on_shortcut(shortcut, pressed).map_err(|error| {
        eprintln!("dozo: the push-to-talk shortcut was refused: {error}");
        taken()
    })
}

/// Tells the person why the switch went back off.
pub fn refused(app: &AppHandle, reason: String) {
    app.dialog()
        .message(reason)
        .title("Dozo")
        .kind(MessageDialogKind::Warning)
        .show(|_| {});
}

fn pressed(app: &AppHandle, _: &Shortcut, event: ShortcutEvent) {
    let down = event.state == ShortcutState::Pressed;
    if down {
        crate::reveal(app);
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let page = window.url().ok();
    if reaches_page(page.as_ref(), crate::chosen(app).as_ref()) {
        let _ = window.eval(script(down));
    }
}

/// Only the chosen server's page hears the shortcut: never the app's own screens, and never a
/// page of another origin.
pub fn reaches_page(page: Option<&Url>, server: Option<&Url>) -> bool {
    crate::alerts::on_server(page, server)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_page_hears_down_and_up_and_nothing_else() {
        assert_eq!(
            script(true),
            "window.dispatchEvent(new CustomEvent('dozo-talk-key', { detail: 'down' }))"
        );
        assert_eq!(
            script(false),
            "window.dispatchEvent(new CustomEvent('dozo-talk-key', { detail: 'up' }))"
        );
    }

    #[test]
    fn only_the_server_s_page_hears_the_shortcut() {
        let server = url("https://dozo.example.com/");
        assert!(reaches_page(
            Some(&url("https://dozo.example.com/space/1")),
            Some(&server)
        ));
        for page in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html?change",
            "https://evil.test/",
            "https://dozo.example.com:8443/",
        ] {
            assert!(!reaches_page(Some(&url(page)), Some(&server)), "{page}");
        }
        assert!(!reaches_page(None, Some(&server)));
        assert!(!reaches_page(Some(&server), None));
    }

    #[test]
    fn a_wayland_desktop_is_told_instead_of_failing_silently() {
        let refused = |display, backend| unavailable(display, backend).is_some();
        let linux = cfg!(target_os = "linux");
        assert_eq!(refused(Some("wayland-0"), None), linux);
        assert_eq!(refused(Some("wayland-0"), Some("wayland")), linux);
        // The app runs through X11 even on a Wayland desktop: the shortcut can work.
        assert!(!refused(Some("wayland-0"), Some("x11")));
        assert!(!refused(Some("wayland-0"), Some("x11,wayland")));
        assert_eq!(refused(Some("wayland-0"), Some("wayland,x11")), linux);
        assert!(!refused(None, None));
        assert!(!refused(Some(""), None));
    }

    #[test]
    fn the_shortcut_and_the_message_name_the_same_keys() {
        let expected = if cfg!(target_os = "macos") {
            Modifiers::SUPER | Modifiers::SHIFT
        } else {
            Modifiers::CONTROL | Modifiers::SHIFT
        };
        assert_eq!(shortcut(), Shortcut::new(Some(expected), Code::Space));
        assert!(LABEL.contains(KEYS));
        assert!(taken().starts_with(KEYS));
    }
}
