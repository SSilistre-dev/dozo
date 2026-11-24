//! The window's frame follows the web app's theme. The page cannot call the app, so the colour
//! comes the way the unread count does: in front of the page's title, as `#0e0e10 (3) Dozo`, from
//! the page's own `theme-color` (its applied background). Only the server's origin is read, only
//! a hex colour is taken, and nothing is sent back. What each system does: README.md, "The
//! window's frame".

use tauri::Theme;
use tauri::window::Color;

/// What the frame is before the page says anything, and on the app's own screens.
pub const FALLBACK: Color = Color(20, 20, 20, 255);

/// The colour a title starts with, as `#rrggbb` and a space, and the rest of the title.
pub fn split_title(title: &str) -> (Option<Color>, &str) {
    let Some((word, rest)) = title.split_once(' ') else {
        return (None, title);
    };
    match parse_hex(word) {
        Some(color) => (Some(color), rest),
        None => (None, title),
    }
}

/// `#rrggbb`, any case, and nothing else.
fn parse_hex(word: &str) -> Option<Color> {
    let digits = word.strip_prefix('#')?;
    if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok();
    Some(Color(channel(0)?, channel(2)?, channel(4)?, 255))
}

/// The frame's tone for a surface colour: light for a light surface, dark otherwise.
pub fn tone(color: Color) -> Theme {
    // Rec. 601 luma, in 0..=255 steps of a thousand.
    let luma = 299 * u32::from(color.0) + 587 * u32::from(color.1) + 114 * u32::from(color.2);
    if luma >= LIGHT_FROM * 1000 {
        Theme::Light
    } else {
        Theme::Dark
    }
}

/// The luma from which a surface counts as light.
const LIGHT_FROM: u32 = 140;

/// What the window's frame shows for the window's own page: the page's colour on the server's
/// origin, and the fallback anywhere else.
pub fn colour_for(on_server: bool, title: &str) -> Color {
    if on_server {
        split_title(title).0.unwrap_or(FALLBACK)
    } else {
        FALLBACK
    }
}

/// Puts the colour on the window, only when it changed.
pub fn show(window: &tauri::WebviewWindow, color: Color) {
    use std::sync::Mutex;
    static SHOWN: Mutex<Option<(u8, u8, u8)>> = Mutex::new(None);
    let mut shown = SHOWN.lock().unwrap();
    let key = (color.0, color.1, color.2);
    if *shown == Some(key) {
        return;
    }
    let result = window
        .set_theme(Some(tone(color)))
        .and_then(|()| window.set_background_color(Some(color)));
    match result {
        Ok(()) => *shown = Some(key),
        Err(error) => eprintln!("dozo: could not colour the window's frame: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_starts_with_its_colour() {
        assert_eq!(
            split_title("#0e0e10 (3) Dozo"),
            (Some(Color(14, 14, 16, 255)), "(3) Dozo")
        );
        assert_eq!(
            split_title("#FFFFFF Dozo"),
            (Some(Color(255, 255, 255, 255)), "Dozo")
        );
        assert_eq!(split_title("#0e0e10 "), (Some(Color(14, 14, 16, 255)), ""));
    }

    #[test]
    fn anything_else_is_no_colour() {
        for title in [
            "Dozo",
            "(3) Dozo",
            "",
            "#0e0e10",
            "#0e0e1 Dozo",
            "#0e0e100 Dozo",
            "#0e0e1g Dozo",
            "0e0e10 Dozo",
            " #0e0e10 Dozo",
            "#0e0e10Dozo",
            "#+e0e10 Dozo",
            "rgb(1, 2, 3) Dozo",
        ] {
            assert_eq!(split_title(title), (None, title), "{title}");
        }
    }

    #[test]
    fn the_tone_is_read_from_the_surface() {
        for (color, expected) in [
            (Color(14, 14, 16, 255), Theme::Dark),
            (Color(17, 22, 33, 255), Theme::Dark),
            (Color(128, 128, 128, 255), Theme::Dark),
            (Color(255, 255, 255, 255), Theme::Light),
            (Color(250, 246, 238, 255), Theme::Light),
            (Color(190, 190, 190, 255), Theme::Light),
        ] {
            assert_eq!(tone(color), expected, "{color:?}");
        }
    }

    #[test]
    fn the_server_decides_and_nothing_else_does() {
        assert_eq!(
            colour_for(true, "#ffffff (2) Dozo"),
            Color(255, 255, 255, 255)
        );
        assert_eq!(colour_for(false, "#ffffff (2) Dozo"), FALLBACK);
        assert_eq!(colour_for(true, "(2) Dozo"), FALLBACK);
    }
}
