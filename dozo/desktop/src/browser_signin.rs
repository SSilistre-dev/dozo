//! The person's side of a sign-in in a bot's browser (`browser.rs`, `Browsers::sign_in`): a small
//! system dialog of this app, not of the page, naming the site, with Done and Cancel. The bot's
//! browser passes nothing on until it is answered.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::oneshot;

pub struct DialogPrompt(pub AppHandle);

impl crate::browser::SignInPrompt for DialogPrompt {
    fn ask(&self, site: &str) -> oneshot::Receiver<bool> {
        let (answer, answered) = oneshot::channel();
        self.0
            .dialog()
            .message(format!(
                "Sign in to {site} in the bot's browser window, then choose Done. Until you choose, for up to 15 minutes, the bot sees nothing there."
            ))
            .title("Dozo")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Done".to_owned(),
                "Cancel".to_owned(),
            ))
            .show(move |done| {
                let _ = answer.send(done);
            });
        answered
    }

    fn ended(&self, site: &str) {
        self.0
            .dialog()
            .message(format!(
                "The sign-in to {site} ended without your answer: the bot has its browser again, and Done or Cancel there no longer does anything."
            ))
            .title("Dozo")
            .show(|_| {});
    }
}
