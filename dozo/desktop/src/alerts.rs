//! The server page's notifications and the unread badge, with no way for the page to call the
//! app: the web view shows the page's own notifications once the server's origin may, and the
//! badge is read from the page title. What each system does: README.md, "Notifications and the
//! unread badge".

use std::sync::Mutex;

use tauri::Url;
use tauri::webview::{PermissionKind, PermissionResponse};

/// An address's origin as scheme, host and port, or None for anything that is not a web address
/// with a host (the local screens, `about:`, `data:`, `blob:`, `file:`).
pub fn notification_origin(server: Option<&Url>) -> Option<String> {
    let server = server.filter(|url| matches!(url.scheme(), "http" | "https"))?;
    let origin = server.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

/// True when `page` has exactly the server's origin: only such a page may show notifications
/// or set the badge.
pub fn on_server(page: Option<&Url>, server: Option<&Url>) -> bool {
    notification_origin(server).is_some_and(|origin| notification_origin(page) == Some(origin))
}

/// The answer to a page asking for a permission, `page` being the window's own page. Only the
/// server's origin may show notifications. The answer is about the window's own page because
/// the web view asks only for it: Windows (Chromium) and Linux (WebKitGTK) refuse a frame of
/// another origin themselves before asking, and Linux also wants a click or key press behind the
/// request. macOS never asks: its web view has no public way to grant a page notifications.
/// Camera, microphone, location and every other kind: refused.
pub fn answer(
    kind: PermissionKind,
    page: Option<&Url>,
    server: Option<&Url>,
) -> PermissionResponse {
    if !cfg!(target_os = "macos")
        && kind == PermissionKind::Notifications
        && on_server(page, server)
    {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Deny
    }
}

/// The largest count the badge shows; more reads as `99+`.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
pub const BADGE_CAP: u32 = 99;

/// The unread count the page puts in front of its title, as `(3) Dozo`. Anything else is 0.
pub fn unread_count(title: &str) -> u32 {
    let Some((count, rest)) = title.strip_prefix('(').and_then(|t| t.split_once(')')) else {
        return 0;
    };
    let digits = count.strip_suffix('+').unwrap_or(count);
    if digits.is_empty()
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || !(rest.is_empty() || rest.starts_with(' '))
    {
        return 0;
    }
    digits.bytes().fold(0u32, |n, digit| {
        n.saturating_mul(10).saturating_add(u32::from(digit - b'0'))
    })
}

/// What the macOS Dock shows: nothing at 0, the count, or `99+`.
#[cfg(any(target_os = "macos", test))]
pub fn badge_label(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=BADGE_CAP => Some(count.to_string()),
        _ => Some(format!("{BADGE_CAP}+")),
    }
}

/// Puts the count on the Dock, taskbar or launcher icon, only when it changed.
pub fn show_unread(window: &tauri::WebviewWindow, count: u32) {
    static SHOWN: Mutex<u32> = Mutex::new(0);
    let mut shown = SHOWN.lock().unwrap();
    if *shown == count {
        return;
    }
    #[cfg(target_os = "macos")]
    let result = window.set_badge_label(badge_label(count));
    // Desktops that show a launcher count (libunity); elsewhere nothing happens.
    #[cfg(target_os = "linux")]
    let result = window.set_badge_count((count > 0).then(|| i64::from(count.min(BADGE_CAP))));
    #[cfg(windows)]
    let result = window.set_overlay_icon(
        overlay_text(count)
            .map(|text| tauri::image::Image::new_owned(overlay(&text), OVERLAY, OVERLAY)),
    );
    match result {
        Ok(()) => *shown = count,
        Err(error) => eprintln!("dozo: could not show the unread count: {error}"),
    }
}

/// The taskbar overlay is small: one digit, or `9+`.
#[cfg(any(windows, test))]
fn overlay_text(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=9 => Some(count.to_string()),
        _ => Some("9+".into()),
    }
}

#[cfg(any(windows, test))]
const OVERLAY: u32 = 32;

/// The overlay icon: white digits on an ink disc with a white rim, RGBA, `OVERLAY` square.
#[cfg(any(windows, test))]
fn overlay(text: &str) -> Vec<u8> {
    // 3 by 5 glyphs, one row per entry, high bit on the left.
    const GLYPHS: [(char, [u8; 5]); 11] = [
        ('0', [7, 5, 5, 5, 7]),
        ('1', [2, 6, 2, 2, 7]),
        ('2', [7, 1, 7, 4, 7]),
        ('3', [7, 1, 7, 1, 7]),
        ('4', [5, 5, 7, 1, 1]),
        ('5', [7, 4, 7, 1, 7]),
        ('6', [7, 4, 7, 5, 7]),
        ('7', [7, 1, 1, 1, 1]),
        ('8', [7, 5, 7, 5, 7]),
        ('9', [7, 5, 7, 1, 7]),
        ('+', [0, 2, 7, 2, 0]),
    ];
    const SCALE: u32 = 3;
    let size = OVERLAY;
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    let mut paint = |x: u32, y: u32, value: u8| {
        let at = ((y * size + x) * 4) as usize;
        pixels[at..at + 4].copy_from_slice(&[value, value, value, 255]);
    };
    let center = (size as f32 - 1.0) / 2.0;
    for y in 0..size {
        for x in 0..size {
            let distance = ((x as f32 - center).powi(2) + (y as f32 - center).powi(2)).sqrt();
            if distance <= center {
                paint(x, y, if distance > center - 2.0 { 255 } else { 20 });
            }
        }
    }
    let glyphs: Vec<[u8; 5]> = text
        .chars()
        .filter_map(|c| GLYPHS.iter().find(|(g, _)| *g == c).map(|(_, rows)| *rows))
        .collect();
    let count = glyphs.len() as u32;
    let width = count * 3 * SCALE + count.saturating_sub(1) * SCALE;
    let left = (size - width) / 2;
    let top = (size - 5 * SCALE) / 2;
    for (index, rows) in glyphs.iter().enumerate() {
        let x0 = left + index as u32 * 4 * SCALE;
        for (row, bits) in rows.iter().enumerate() {
            for column in 0..3 {
                if bits & (4 >> column) == 0 {
                    continue;
                }
                for dy in 0..SCALE {
                    for dx in 0..SCALE {
                        paint(x0 + column * SCALE + dx, top + row as u32 * SCALE + dy, 255);
                    }
                }
            }
        }
    }
    pixels
}

/// Linux: a click on one of the page's notifications brings the window back, hidden or not. The
/// web view shows them through the desktop's notification service and tells the page of the
/// click as well; this only listens.
#[cfg(target_os = "linux")]
pub fn reveal_on_click(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri::Manager;
    use webkit2gtk::{NotificationExt, WebViewExt};
    let app = window.app_handle().clone();
    window.with_webview(move |webview| {
        webview
            .inner()
            .connect_show_notification(move |_, notification| {
                let app = app.clone();
                notification.connect_clicked(move |_| crate::reveal(&app));
                // The web view's own handling shows it.
                false
            });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_server_s_exact_origin_may_notify() {
        let server = url("https://dozo.example.com/");
        let local = url("http://127.0.0.1:5173/");
        for (page, server, allowed) in [
            ("https://dozo.example.com/space/1?x=1", &server, true),
            ("https://dozo.example.com:443/", &server, true),
            ("http://127.0.0.1:5173/chat", &local, true),
            // Another port, scheme, host or a look-alike: another origin.
            ("https://dozo.example.com:8443/", &server, false),
            ("http://dozo.example.com/", &server, false),
            ("https://sub.dozo.example.com/", &server, false),
            ("https://dozo.example.com.evil.test/", &server, false),
            ("https://example.com/", &server, false),
            ("https://127.0.0.1:5173/", &local, false),
            ("http://127.0.0.1:5174/", &local, false),
            ("http://localhost:5173/", &local, false),
            // Not a web page with an origin of its own.
            ("tauri://localhost/index.html", &server, false),
            ("about:blank", &server, false),
            ("data:text/html,x", &server, false),
            ("blob:https://dozo.example.com/0b0e", &server, false),
            ("file:///etc/passwd", &server, false),
        ] {
            assert_eq!(
                on_server(Some(&url(page)), Some(server)),
                allowed,
                "{page} for {server}"
            );
        }
        // No page, no server, or a server that is not a web address.
        assert!(!on_server(None, Some(&server)));
        assert!(!on_server(Some(&server), None));
        assert!(!on_server(None, None));
        let local_screen = url("tauri://localhost/");
        assert!(!on_server(Some(&local_screen), Some(&local_screen)));
        assert_eq!(
            notification_origin(Some(&url("https://dozo.example.com:8443/x"))).as_deref(),
            Some("https://dozo.example.com:8443")
        );
        assert_eq!(notification_origin(Some(&local_screen)), None);
    }

    #[test]
    fn every_other_permission_is_refused() {
        let server = url("https://dozo.example.com/");
        for kind in [
            PermissionKind::Camera,
            PermissionKind::Microphone,
            PermissionKind::Geolocation,
            PermissionKind::DisplayCapture,
            PermissionKind::ClipboardRead,
            PermissionKind::Other,
        ] {
            assert_eq!(
                answer(kind, Some(&server), Some(&server)),
                PermissionResponse::Deny
            );
        }
        let elsewhere = url("https://evil.test/");
        assert_eq!(
            answer(
                PermissionKind::Notifications,
                Some(&elsewhere),
                Some(&server)
            ),
            PermissionResponse::Deny
        );
        let expected = if cfg!(target_os = "macos") {
            PermissionResponse::Deny
        } else {
            PermissionResponse::Allow
        };
        assert_eq!(
            answer(PermissionKind::Notifications, Some(&server), Some(&server)),
            expected
        );
    }

    #[test]
    fn the_count_comes_from_the_front_of_the_title_only() {
        for (title, count) in [
            ("Dozo", 0),
            ("", 0),
            ("(0) Dozo", 0),
            ("(3) Dozo", 3),
            ("(3)", 3),
            ("(12) Dozo – Sign in", 12),
            ("(9999+) Dozo", 9999),
            ("(99999999999999999999) Dozo", u32::MAX),
            // Broken or elsewhere: no count.
            ("(abc) Dozo", 0),
            ("() Dozo", 0),
            ("(+) Dozo", 0),
            ("(3 Dozo", 0),
            ("3) Dozo", 0),
            ("(3)Dozo", 0),
            ("(-3) Dozo", 0),
            ("( 3) Dozo", 0),
            ("Dozo (3)", 0),
            ("(٣) Dozo", 0),
        ] {
            assert_eq!(unread_count(title), count, "{title:?}");
        }
    }

    #[test]
    fn the_badge_is_capped_and_cleared_at_zero() {
        assert_eq!(badge_label(0), None);
        assert_eq!(badge_label(1).as_deref(), Some("1"));
        assert_eq!(badge_label(99).as_deref(), Some("99"));
        assert_eq!(badge_label(100).as_deref(), Some("99+"));
        assert_eq!(badge_label(u32::MAX).as_deref(), Some("99+"));
        assert_eq!(overlay_text(0), None);
        assert_eq!(overlay_text(7).as_deref(), Some("7"));
        assert_eq!(overlay_text(10).as_deref(), Some("9+"));
    }

    #[test]
    fn the_overlay_is_a_disc_with_the_digits_in_white() {
        let at = |pixels: &[u8], x: u32, y: u32| {
            let i = ((y * OVERLAY + x) * 4) as usize;
            [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
        };
        for text in ["1", "8", "9+"] {
            let pixels = overlay(text);
            assert_eq!(pixels.len(), (OVERLAY * OVERLAY * 4) as usize);
            assert_eq!(at(&pixels, 0, 0), [0, 0, 0, 0], "{text}: a corner is clear");
            assert_eq!(at(&pixels, 16, 1), [255, 255, 255, 255], "{text}: the rim");
            assert_eq!(at(&pixels, 16, 4), [20, 20, 20, 255], "{text}: the disc");
            let white = (8..24)
                .flat_map(|y| (6..26).map(move |x| (x, y)))
                .filter(|&(x, y)| at(&pixels, x, y) == [255, 255, 255, 255])
                .count();
            assert!(
                white >= 5 * 9,
                "{text}: the digits are drawn ({white} pixels)"
            );
        }
        assert_ne!(overlay("1"), overlay("7"));
    }
}
