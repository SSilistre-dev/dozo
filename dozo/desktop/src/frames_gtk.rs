//! Linux counterpart of `frames.rs`. WebKitGTK asks Tauri's navigation hook about every frame and
//! says nothing about which frame it is, so the hook lets web addresses through
//! (`server::hook_verdict`) and frames inside the page load as they would in a browser. The
//! window's own page is checked here instead, when the answer to its request arrives: WebKitGTK
//! marks that answer (2.40 or later), and one the gate refuses is dropped before anything of it
//! shows. The request itself has gone out by then, as a page's own script could send it.

use tauri::Url;
use webkit2gtk::{
    PolicyDecisionExt, PolicyDecisionType, ResponsePolicyDecision, ResponsePolicyDecisionExt,
    URIResponseExt, WebViewExt, glib::object::Cast,
};

/// Installs the gate on a window's web view. `allow` gets the final address (after redirects) of
/// each page the window itself loads and says whether it may show.
pub fn only_gate_the_main_frame(
    window: &tauri::WebviewWindow,
    allow: impl Fn(&Url) -> bool + Send + 'static,
) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        webview
            .inner()
            .connect_decide_policy(move |_, decision, kind| {
                let Some(response) = (kind == PolicyDecisionType::Response)
                    .then(|| decision.downcast_ref::<ResponsePolicyDecision>())
                    .flatten()
                    .filter(|response| response.is_main_frame_main_resource())
                else {
                    return false;
                };
                let address = response
                    .response()
                    .and_then(|answer| answer.uri())
                    .and_then(|uri| uri.parse::<Url>().ok());
                if address.is_some_and(|url| allow(&url)) {
                    // The web view's own handling: show it or download it.
                    return false;
                }
                decision.ignore();
                true
            });
    })
}
