//! Linux counterpart of `frames.rs`. WebKitGTK asks about every navigation without saying which
//! frame it is for, so Tauri's navigation hook would send each cross-origin frame inside the page
//! (a bot's screen) to the browser. This takes over that one question from the hook:
//! - A navigation the user started (a click) is judged as the window's own page before its
//!   request goes out, so a link to another site opens in the browser and is not loaded here. A
//!   link clicked inside a frame is judged the same way and also opens in the browser.
//! - Any other web navigation may go ahead, so frames load as they do in a browser, and the
//!   window's own page is judged when the answer to its request arrives (WebKitGTK 2.40 or later
//!   marks that answer): a refused page never shows, though its request has gone out, as the
//!   page's own script could send it. A web address it refuses opens in the browser (a sign-in
//!   that redirects to another site); a script cannot hand anything else (a mail link) outside.

use tauri::Url;
use webkit2gtk::glib::object::{Cast, ObjectType};
use webkit2gtk::glib::{StaticType, gobject_ffi, translate::IntoGlib};
use webkit2gtk::{
    NavigationPolicyDecision, NavigationPolicyDecisionExt, PolicyDecisionExt, PolicyDecisionType,
    ResponsePolicyDecision, ResponsePolicyDecisionExt, URIRequestExt, URIResponseExt, WebViewExt,
};

use crate::server::{Verdict, decide};

/// What is known about a navigation when it is judged.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seen {
    /// Started by the user, before its request goes out: judged as the window's own page.
    Click,
    /// Started by a script or the app, in any frame, before its request goes out.
    Script,
    /// The answer for the window's own page, after any redirects.
    MainPage,
}

/// Where a navigation goes. Before a request, only a click can open something outside the app.
pub fn verdict(url: &Url, server: Option<&Url>, seen: Seen) -> Verdict {
    match (seen, url.scheme()) {
        (Seen::Click | Seen::MainPage, _) => decide(url, server),
        (Seen::Script, "http" | "https" | "blob") => Verdict::Window,
        (Seen::Script, _) => match decide(url, server) {
            Verdict::Browser(_) => Verdict::Refused,
            other => other,
        },
    }
}

/// Installs the gate on a window's web view. `allow` acts on each navigation and says whether it
/// may load.
pub fn only_gate_the_main_frame(
    window: &tauri::WebviewWindow,
    allow: impl Fn(&Url, Seen) -> bool + Send + 'static,
) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        let view = webview.inner();
        // Tauri's hook answers navigations first and ends the question there; set it aside.
        // Should it not be found, the hook still refuses what leaves the server: frames from
        // other sites then stay blank, nothing unsafe.
        unsafe {
            let instance = view.as_ptr().cast::<gobject_ffi::GObject>();
            let signal = gobject_ffi::g_signal_lookup(
                c"decide-policy".as_ptr(),
                webkit2gtk::WebView::static_type().into_glib(),
            );
            let hook = gobject_ffi::g_signal_handler_find(
                instance,
                gobject_ffi::G_SIGNAL_MATCH_ID,
                signal,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if hook == 0 {
                eprintln!("dozo: the navigation hook was not found, frames are not told apart");
                return;
            }
            gobject_ffi::g_signal_handler_block(instance, hook);
        }
        view.connect_decide_policy(move |_, decision, kind| {
            let (url, seen) = match kind {
                PolicyDecisionType::NavigationAction => {
                    let Some(action) = decision
                        .downcast_ref::<NavigationPolicyDecision>()
                        .and_then(|navigation| navigation.navigation_action())
                    else {
                        return false;
                    };
                    let seen = if action.is_user_gesture() {
                        Seen::Click
                    } else {
                        Seen::Script
                    };
                    let url = action.request().and_then(|request| request.uri());
                    (url, seen)
                }
                PolicyDecisionType::Response => {
                    let Some(response) = decision
                        .downcast_ref::<ResponsePolicyDecision>()
                        .filter(|response| response.is_main_frame_main_resource())
                    else {
                        return false;
                    };
                    let url = response.response().and_then(|answer| answer.uri());
                    (url, Seen::MainPage)
                }
                _ => return false,
            };
            if url
                .and_then(|uri| uri.parse::<Url>().ok())
                .is_some_and(|url| allow(&url, seen))
            {
                // The web view's own handling: load it, show it or download it.
                return false;
            }
            decision.ignore();
            true
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
    fn a_click_is_judged_as_the_window_s_own_page() {
        let server = url("https://dozo.example.com/");
        for (address, expected) in [
            ("https://dozo.example.com/space", Verdict::Window),
            (
                "https://evil.test/",
                Verdict::Browser(url("https://evil.test/")),
            ),
            (
                "mailto:someone@example.com",
                Verdict::Browser(url("mailto:someone@example.com")),
            ),
            ("file:///etc/passwd", Verdict::Refused),
        ] {
            assert_eq!(verdict(&url(address), Some(&server), Seen::Click), expected);
            assert_eq!(
                verdict(&url(address), Some(&server), Seen::MainPage),
                expected
            );
        }
    }

    #[test]
    fn a_script_loads_web_addresses_in_any_frame_and_opens_nothing_outside() {
        let server = url("https://dozo.example.com/");
        for web in [
            "https://evil.test/",
            "http://evil.test/",
            "blob:https://evil.test/0b0e",
        ] {
            assert_eq!(
                verdict(&url(web), Some(&server), Seen::Script),
                Verdict::Window
            );
        }
        for refused in [
            "mailto:someone@example.com",
            "file:///etc/passwd",
            "data:text/html,x",
        ] {
            assert_eq!(
                verdict(&url(refused), Some(&server), Seen::Script),
                Verdict::Refused
            );
        }
    }
}
