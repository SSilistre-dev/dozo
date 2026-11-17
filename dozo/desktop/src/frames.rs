//! Tauri's navigation hook is asked about every frame and cannot tell the window's own page from
//! a frame inside it, so on its own it would send each cross-origin frame the web app embeds (a
//! bot's screen, a linked page) to the browser. This puts a delegate in front of the webview's
//! own: a frame inside the page loads as it would in a browser, and every other decision,
//! including every navigation of the window's own page, still goes to the original.

use block2::Block;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_web_kit::{
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKWebView,
};

struct Ivars {
    original: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    struct FrameGate;

    unsafe impl NSObjectProtocol for FrameGate {}

    unsafe impl WKNavigationDelegate for FrameGate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide(&self, webview: &WKWebView, action: &WKNavigationAction, handler: &Block<dyn Fn(WKNavigationActionPolicy)>) {
            // No target frame means a new window: that is the original's to refuse.
            let inner_frame =
                unsafe { action.targetFrame() }.is_some_and(|frame| !unsafe { frame.isMainFrame() });
            let download = unsafe { action.shouldPerformDownload() };
            // The hook behind the original lets through an address it cannot parse.
            let parses = unsafe { action.request().URL() }
                .and_then(|url| url.absoluteString())
                .is_some_and(|url| url.to_string().parse::<tauri::Url>().is_ok());
            if inner_frame && !download {
                handler.call((WKNavigationActionPolicy::Allow,));
            } else if !download && !parses {
                handler.call((WKNavigationActionPolicy::Cancel,));
            } else {
                unsafe {
                    self.ivars()
                        .original
                        .webView_decidePolicyForNavigationAction_decisionHandler(
                            webview, action, handler,
                        )
                };
            }
        }
    }

    impl FrameGate {
        // WebKit asks which delegate methods exist and calls only those. Answer for the original
        // and pass on every method not written here.
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            self.ivars().original.respondsToSelector(selector)
        }

        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target(&self, _selector: Sel) -> *mut AnyObject {
            Retained::as_ptr(&self.ivars().original).cast::<AnyObject>().cast_mut()
        }
    }
);

/// Installs the gate on a window's webview. Call once, on the main thread, after the window is built.
pub fn only_gate_the_main_frame(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
        // SAFETY: on macOS `inner()` is the window's live WKWebView.
        let webview = unsafe { &*webview.inner().cast::<WKWebView>() };
        let Some(original) = (unsafe { webview.navigationDelegate() }) else {
            // Without the gate every cross-origin frame goes to the browser: safe, but broken.
            eprintln!("dozo: the web view has no navigation delegate, frames are not told apart");
            return;
        };
        let gate = mtm.alloc::<FrameGate>().set_ivars(Ivars { original });
        let gate: Retained<FrameGate> = unsafe { msg_send![super(gate), init] };
        unsafe { webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*gate))) };
        // The webview holds its delegate weakly and the window lives as long as the app does.
        std::mem::forget(gate);
    })
}
