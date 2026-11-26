//! Sign-up on the server on this computer. Upstream's server admits the first account on the
//! app-managed server (`RAKAZO_DESKTOP_STACK_TOKEN` set) only to a request carrying a cookie the
//! app's own window sets (`packages/core/src/node/local-signup.ts`, and `syncLocalSignup` in the
//! upstream desktop app); without it sign-up answers 400 `REGISTRATION_CLOSED`. The window carries
//! the cookie for the server on this computer and for no other: the page cannot read it, and only
//! the auth routes receive it. The cookie holds a key derived from the stack token, never the
//! token itself. Cookies ignore the port, so it is removed whenever the window is set to anything
//! but the server on this computer (`crate::sync_local_signup`).

use sha2::{Digest, Sha256};
use tauri::webview::cookie::{Cookie, SameSite};
use tauri::{Url, WebviewWindow};

/// The cookie's name: upstream's `LOCAL_SIGNUP_COOKIE`.
pub const COOKIE: &str = "rakazo_local_signup";
/// Only the auth routes receive it: upstream's `LOCAL_SIGNUP_PATH`.
const PATH: &str = "/api/auth";
/// The label the key is derived over: upstream's `localSignupKey`.
const LABEL: &str = "rakazo:local-signup";
/// The server on this computer listens here (`stack::Plan`).
const HOST: &str = "127.0.0.1";

/// HMAC-SHA256 (RFC 2104) of `message` under `key`, from the `sha2` the app already builds.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// What the cookie holds: derived from the private stack token, so a copy sent to another local
/// server can only create accounts here, never change the host settings the token itself unlocks.
pub fn key(stack_token: &str) -> String {
    hmac_sha256(stack_token.as_bytes(), LABEL.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Does the window carry the cookie: only while the server on this computer is the chosen one.
/// `server` can still be a remote one while the choice of this computer is being made.
pub fn wanted(this_computer: bool, server: Option<&Url>) -> bool {
    this_computer
        && server.is_some_and(|server| server.scheme() == "http" && server.host_str() == Some(HOST))
}

fn cookie(value: String) -> Cookie<'static> {
    Cookie::build((COOKIE, value))
        .domain(HOST)
        .path(PATH)
        .http_only(true)
        .same_site(SameSite::Lax)
        .build()
}

/// Sets the cookie to `key`, or removes it (`None`). A session cookie, as upstream's: it is gone
/// when the app ends. Off the main thread: the web view's cookie calls wait for it on Windows.
pub async fn sync(window: WebviewWindow, key: Option<String>) {
    let done = tauri::async_runtime::spawn_blocking(move || match key {
        Some(key) => window.set_cookie(cookie(key)),
        None => window.delete_cookie(cookie(String::new())),
    })
    .await;
    match done {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("dozo: could not change the sign-up cookie: {error}"),
        Err(error) => eprintln!("dozo: could not change the sign-up cookie: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_upstreams_hmac_of_the_token() {
        // Computed with Python's hmac over upstream's label: a token shorter than a block, and
        // one longer, which HMAC hashes first.
        assert_eq!(
            key("stack-token"),
            "395b48c8b2e34f7c716bef9fb0ab73d0e925fae43fb97b9029e3939c75dd3c96"
        );
        assert_eq!(
            key(&"k".repeat(100)),
            "a6fc9d9cd71b1283df6ec410c15c7093178ce663851cc67d2209e2b64b94ae29"
        );
    }

    #[test]
    fn only_the_server_on_this_computer_gets_the_cookie() {
        let url = |text: &str| Url::parse(text).unwrap();
        let local = url("http://127.0.0.1:3000/");
        assert!(wanted(true, Some(&local)));
        assert!(!wanted(false, Some(&local)));
        assert!(!wanted(true, None));
        assert!(!wanted(true, Some(&url("https://app.example.test/"))));
        assert!(!wanted(true, Some(&url("http://localhost:3000/"))));
    }
}
