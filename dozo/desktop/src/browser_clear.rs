//! Clearing a bot's browser (`browser.rs`, `Browsers::clear`): the Dozo menu, and so the Settings
//! window, which lists the menu, has one item for each bot whose browser this computer keeps, shown
//! only once there is one. Picking it asks first; clearing ends the browser, removes its profile
//! (every sign-in, cookie and page it kept), and the server forgets what the bot was allowed there
//! on its next use.

use tauri::menu::{MenuItem, MenuItemKind};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::{MENU_ID, device, prefs, words};

/// The items' ids: this, then the bot's key.
pub const PREFIX: &str = "clear-browser:";

/// The item's words for a bot, in the system's language.
fn label(name: &str, turkish: bool) -> String {
    if turkish {
        format!("{name} Tarayıcısını Temizle…")
    } else {
        format!("Clear {name}'s Browser…")
    }
}

/// What the menu should list: (id, words) for each bot whose browser is kept.
fn wanted(names: &[(String, String)], turkish: bool) -> Vec<(String, String)> {
    names
        .iter()
        .map(|(key, name)| (format!("{PREFIX}{key}"), label(name, turkish)))
        .collect()
}

/// Brings the Dozo menu's items in line with the browsers kept now, right after the switch that
/// lets bots use this computer.
pub fn sync(app: &AppHandle) {
    let Some(access) = app.try_state::<device::Access>() else {
        return;
    };
    let want = wanted(&access.runner().browser_names(), words::turkish());
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let app = &handle;
        let Some(MenuItemKind::Submenu(menu)) = app.menu().and_then(|menu| menu.get(MENU_ID))
        else {
            return;
        };
        let items = menu.items().unwrap_or_default();
        for item in &items {
            let id = &item.id().0;
            let same = |(wanted, words): &(String, String)| {
                wanted == id
                    && matches!(item, MenuItemKind::MenuItem(item) if item.text().is_ok_and(|text| &text == words))
            };
            if id.starts_with(PREFIX) && !want.iter().any(same) {
                let _ = menu.remove(item);
            }
        }
        let items = menu.items().unwrap_or_default();
        let Some(mut at) = items
            .iter()
            .position(|item| item.id().0 == device::MENU_ID)
            .map(|at| at + 1)
        else {
            return;
        };
        for (id, words) in &want {
            if let Some(found) = items.iter().position(|item| &item.id().0 == id) {
                at = found + 1;
                continue;
            }
            if let Ok(item) = MenuItem::with_id(app, id, words, true, None::<&str>)
                && menu.insert(&item, at).is_ok()
            {
                at += 1;
            }
        }
        prefs::changed(app);
    });
}

/// The item was picked: asks, then clears that bot's browser.
pub fn clicked(app: &AppHandle, id: &str) {
    let Some(key) = id.strip_prefix(PREFIX).map(str::to_owned) else {
        return;
    };
    let Some(access) = app.try_state::<device::Access>() else {
        return;
    };
    let Some((_, name)) = access
        .runner()
        .browser_names()
        .into_iter()
        .find(|(known, _)| *known == key)
    else {
        return;
    };
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "Clear {name}'s browser? It is signed out of every site, and asks again before using the browser."
        ))
        .title("Dozo")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Clear".to_owned(),
            "Cancel".to_owned(),
        ))
        .show(move |clear| {
            if !clear {
                return;
            }
            tauri::async_runtime::spawn(async move {
                let runner = handle.state::<device::Access>().runner().clone();
                runner.clear_browser(&key).await;
            });
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_item_per_kept_browser_named_after_its_bot() {
        let names = vec![
            ("k1".to_owned(), "Ada".to_owned()),
            ("k2".to_owned(), "Bo".to_owned()),
        ];
        assert_eq!(
            wanted(&names, false),
            vec![
                (
                    "clear-browser:k1".to_owned(),
                    "Clear Ada's Browser…".to_owned()
                ),
                (
                    "clear-browser:k2".to_owned(),
                    "Clear Bo's Browser…".to_owned()
                ),
            ]
        );
        assert_eq!(wanted(&names, true)[0].1, "Ada Tarayıcısını Temizle…");
        assert!(wanted(&[], false).is_empty());
    }
}
