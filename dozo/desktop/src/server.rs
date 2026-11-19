//! Which server address the app accepts and where a URL may load. Pure logic, tested below.

use std::net::{IpAddr, TcpStream};
use std::time::Duration;
use tauri::Url;

/// The app's own screens (ui/), at the address Tauri serves them from: its own scheme, or on
/// Windows, where the web view has no such scheme, a host name only the app answers for.
/// `?change` asks for the server form.
#[cfg(not(windows))]
pub const LOCAL: &str = "tauri://localhost/index.html";
#[cfg(windows)]
pub const LOCAL: &str = "http://tauri.localhost/index.html";

/// True for the app's own screens.
pub fn is_local(url: &Url) -> bool {
    if cfg!(windows) {
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none()
    } else {
        url.scheme() == "tauri" && url.host_str() == Some("localhost")
    }
}

/// Where a navigation of the window's own page goes.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Loads in the app window.
    Window,
    /// Opens in the default browser (or mail app), as this URL.
    Browser(Url),
    Refused,
}

/// Turns what the user typed into the server's origin. `https://` is assumed when no scheme is
/// given, and `http://` only for this computer.
pub fn parse_server(input: &str) -> Result<Url, &'static str> {
    const INVALID: &str = "Enter a server address, like https://dozo.example.com";
    let input = input.trim();
    // Without a scheme: http:// for this computer, https:// for everything else.
    let mut url = if input.contains("://") {
        Url::parse(input)
    } else {
        Url::parse(&format!("http://{input}"))
            .ok()
            .filter(is_loopback)
            .map_or_else(|| Url::parse(&format!("https://{input}")), Ok)
    }
    .map_err(|_| INVALID)?;
    if url.host_str().is_none_or(str::is_empty) {
        return Err(INVALID);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The address must not contain a user name or password");
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&url) => {}
        "http" => {
            return Err("Use https://. Plain http:// works only for a server on this computer");
        }
        _ => return Err("The address must start with https://"),
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    let address = host.trim_matches(['[', ']']).parse::<IpAddr>();
    host == "localhost" || address.is_ok_and(|ip| ip.is_loopback())
}

/// What to hand the default browser or mail app for a link, if anything. A mail link keeps only
/// its address: what a mail app does with other fields (attachments) is not ours to trust.
pub fn outside(url: &Url) -> Option<Url> {
    let mut url = url.clone();
    match url.scheme() {
        "http" | "https" => {}
        "mailto" => url.set_query(None),
        _ => return None,
    }
    Some(url)
}

/// Only the app's own screens and the chosen server's origin load in the window.
pub fn decide(url: &Url, server: Option<&Url>) -> Verdict {
    let on_server = server.is_some_and(|server| server.origin() == url.origin());
    match url.scheme() {
        _ if is_local(url) => Verdict::Window,
        "about" => Verdict::Window,
        // A blob URL carries the origin of the page that made it.
        "http" | "https" | "blob" if on_server => Verdict::Window,
        _ => outside(url).map_or(Verdict::Refused, Verdict::Browser),
    }
}

/// What the navigation hook answers. On Linux the hook is asked about frames too and cannot tell
/// them from the window's own page, so it lets every web address through and `frames_gtk.rs`
/// gives the window's own page the `decide` verdict when its answer arrives.
pub fn hook_verdict(url: &Url, server: Option<&Url>) -> Verdict {
    match url.scheme() {
        "http" | "https" | "blob" if cfg!(target_os = "linux") => Verdict::Window,
        _ => decide(url, server),
    }
}

/// True when something accepts a connection at the server's address.
// ponytail: a TCP connect, not an HTTP request, so a proxy in front of a stopped server still
// counts as reachable and the proxy's own error page shows. Send a real request if that confuses.
pub fn reachable(server: &Url) -> bool {
    server.socket_addrs(|| None).is_ok_and(|addrs| {
        addrs
            .iter()
            .any(|addr| TcpStream::connect_timeout(addr, Duration::from_secs(4)).is_ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn accepts_https_and_keeps_only_the_origin() {
        assert_eq!(
            parse_server("https://dozo.example.com").unwrap().as_str(),
            "https://dozo.example.com/"
        );
        assert_eq!(
            parse_server("  dozo.example.com/login?next=1#top ")
                .unwrap()
                .as_str(),
            "https://dozo.example.com/"
        );
        assert_eq!(
            parse_server("https://dozo.example.com:8443/app")
                .unwrap()
                .as_str(),
            "https://dozo.example.com:8443/"
        );
    }

    #[test]
    fn accepts_http_only_for_this_computer() {
        for ok in [
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://[::1]:5173",
            "http://127.8.9.1",
        ] {
            assert!(parse_server(ok).is_ok(), "{ok}");
        }
        assert_eq!(
            parse_server("127.0.0.1:5173").unwrap().as_str(),
            "http://127.0.0.1:5173/"
        );
        assert_eq!(
            parse_server("localhost:5173").unwrap().as_str(),
            "http://localhost:5173/"
        );
        assert_eq!(
            parse_server("localhost:443").unwrap().as_str(),
            "http://localhost:443/"
        );
        assert_eq!(
            parse_server("dozo.example.com:8443").unwrap().as_str(),
            "https://dozo.example.com:8443/"
        );
        for bad in [
            "http://dozo.example.com",
            "http://192.168.1.10:5173",
            "http://127.0.0.1.example.com",
            "http://localhost.example.com",
            "http://0.0.0.0:5173",
        ] {
            assert!(parse_server(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_what_is_not_a_server_address() {
        for bad in [
            "",
            "   ",
            "https://",
            "ftp://dozo.example.com",
            "file:///etc/passwd",
            "javascript://x",
            "https://user:pw@dozo.example.com",
            "https://user@dozo.example.com",
            "tauri://localhost",
        ] {
            assert!(parse_server(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_the_chosen_origin_and_the_local_screens_load_in_the_window() {
        let server = url("https://dozo.example.com/");
        let window = |s: &str| decide(&url(s), Some(&server));
        assert_eq!(
            window("https://dozo.example.com/space/1?x=1"),
            Verdict::Window
        );
        assert_eq!(
            window("blob:https://dozo.example.com/0b0e"),
            Verdict::Window
        );
        assert_eq!(window(&format!("{LOCAL}?change")), Verdict::Window);
        assert_eq!(window("about:blank"), Verdict::Window);
        // Same host, another scheme or port, and look-alike hosts are other origins.
        for other in [
            "http://dozo.example.com/",
            "https://dozo.example.com:8443/",
            "https://dozo.example.com.evil.test/",
            "https://evil.test/dozo.example.com",
            "https://dozo.example.com@evil.test/",
            "https://sub.dozo.example.com/",
            "mailto:someone@example.com",
        ] {
            assert_eq!(window(other), Verdict::Browser(url(other)), "{other}");
        }
        for refused in [
            "file:///etc/passwd",
            "data:text/html,x",
            "blob:https://evil.test/0b0e",
            "tauri://evil/index.html",
            "ftp://dozo.example.com/",
            "x-apple-helpbasic://x",
        ] {
            assert_eq!(window(refused), Verdict::Refused, "{refused}");
        }
    }

    #[test]
    fn a_mail_link_keeps_only_its_address() {
        let link = url("mailto:someone@example.com?subject=Hi&attach=/etc/passwd");
        assert_eq!(outside(&link), Some(url("mailto:someone@example.com")));
        assert_eq!(outside(&url("file:///etc/passwd")), None);
        assert_eq!(outside(&url("x-apple-helpbasic://x")), None);
    }

    #[test]
    fn nothing_remote_loads_in_the_window_before_a_server_is_chosen() {
        let server = url("https://dozo.example.com/");
        assert_eq!(decide(&server, None), Verdict::Browser(server.clone()));
        assert_eq!(
            decide(&url("blob:https://dozo.example.com/0b0e"), None),
            Verdict::Refused
        );
        assert_eq!(decide(&url(LOCAL), None), Verdict::Window);
    }

    #[test]
    fn the_hook_lets_web_addresses_through_only_on_linux() {
        let server = url("https://dozo.example.com/");
        for web in [
            "https://evil.test/",
            "http://evil.test/",
            "blob:https://evil.test/0b0e",
        ] {
            let expected = if cfg!(target_os = "linux") {
                Verdict::Window
            } else {
                decide(&url(web), Some(&server))
            };
            assert_eq!(hook_verdict(&url(web), Some(&server)), expected, "{web}");
        }
        // Everything else is the same verdict everywhere.
        for other in [
            "file:///etc/passwd",
            "data:text/html,x",
            "mailto:someone@example.com",
        ] {
            let other = url(other);
            assert_eq!(
                hook_verdict(&other, Some(&server)),
                decide(&other, Some(&server))
            );
        }
    }

    // The Windows address of the local screens is a web address: nothing near it may pass for it.
    #[cfg(windows)]
    #[test]
    fn only_the_exact_local_address_is_local() {
        for other in [
            "https://tauri.localhost/index.html",
            "http://tauri.localhost:8080/index.html",
            "http://tauri.localhost.evil.test/",
            "http://evil.tauri.localhost/",
            "http://localhost/index.html",
        ] {
            assert!(!is_local(&url(other)), "{other}");
        }
        // Nor can it be chosen as the server.
        assert!(parse_server("http://tauri.localhost").is_err());
    }

    #[test]
    fn an_address_nothing_listens_on_is_not_reachable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        assert!(reachable(&parse_server(&address).unwrap()));
        drop(listener);
        assert!(!reachable(&parse_server(&address).unwrap()));
        assert!(!reachable(&url("https://no-such-host.invalid/")));
    }
}
