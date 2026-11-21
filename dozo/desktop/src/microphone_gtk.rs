//! Linux: WebKitGTK leaves the microphone out of every page unless the app turns media capture on
//! (`enable-media-stream` is off by default), so the server's page could never ask for it. Which
//! page may have it is decided when one asks, by `alerts::answer`: the server's origin only.
//! macOS and Windows have capture on already. README.md, "The microphone".

use webkit2gtk::{SettingsExt, WebViewExt};

pub fn turn_on_capture(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        if let Some(settings) = webview.inner().settings() {
            settings.set_enable_media_stream(true);
        }
    })
}
