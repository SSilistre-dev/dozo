//! What the app saves between launches, in one small file in the app's config folder: the server
//! address on the first line (the whole file, before the two switches existed) and one
//! `name=true|false` line per switch. A missing switch is off. Pure logic, tested below.

use tauri::Url;

use crate::server::parse_server;

const OPEN_AT_LOGIN: &str = "open_at_login=";
const KEEP_RUNNING: &str = "keep_running=";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settings {
    pub server: Option<Url>,
    /// Start when the user signs in to the computer.
    pub open_at_login: bool,
    /// Closing the window leaves the app running.
    pub keep_running: bool,
}

/// Reads the file. The address is checked again: the file may have been edited by hand.
pub fn parse(text: &str) -> Settings {
    let mut settings = Settings::default();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some(value) = line.strip_prefix(OPEN_AT_LOGIN) {
            settings.open_at_login = value.trim() == "true";
        } else if let Some(value) = line.strip_prefix(KEEP_RUNNING) {
            settings.keep_running = value.trim() == "true";
        } else if settings.server.is_none() {
            settings.server = parse_server(line).ok();
        }
    }
    settings
}

pub fn render(settings: &Settings) -> String {
    let mut text = settings
        .server
        .as_ref()
        .map_or_else(String::new, |server| format!("{server}\n"));
    text.push_str(&format!("{OPEN_AT_LOGIN}{}\n", settings.open_at_login));
    text.push_str(&format!("{KEEP_RUNNING}{}\n", settings.keep_running));
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Option<Url> {
        Some(Url::parse("https://dozo.example.com/").unwrap())
    }

    #[test]
    fn the_old_file_is_an_address_and_both_switches_are_off() {
        for old in [
            "https://dozo.example.com/",
            "https://dozo.example.com/\n",
            "  https://dozo.example.com \n\n",
        ] {
            assert_eq!(
                parse(old),
                Settings {
                    server: server(),
                    ..Settings::default()
                }
            );
        }
    }

    #[test]
    fn a_missing_or_unclear_switch_is_off() {
        assert_eq!(parse(""), Settings::default());
        let text = "https://dozo.example.com/\nopen_at_login=yes\n";
        assert_eq!(parse(text).server, server());
        assert!(!parse(text).open_at_login && !parse(text).keep_running);
    }

    #[test]
    fn what_is_written_is_read_back() {
        for (open_at_login, keep_running) in
            [(false, false), (true, false), (false, true), (true, true)]
        {
            for server in [server(), None] {
                let settings = Settings {
                    server,
                    open_at_login,
                    keep_running,
                };
                assert_eq!(parse(&render(&settings)), settings);
            }
        }
    }

    #[test]
    fn the_address_stays_the_first_line() {
        let settings = Settings {
            server: server(),
            open_at_login: true,
            keep_running: true,
        };
        assert_eq!(
            render(&settings).lines().next(),
            Some("https://dozo.example.com/")
        );
    }

    #[test]
    fn switches_without_an_address_leave_it_unset_and_a_bad_address_is_dropped() {
        assert_eq!(parse("keep_running=true\n").server, None);
        assert_eq!(
            parse("http://example.com/\nkeep_running=true\n").server,
            None
        );
        assert!(parse("http://example.com/\nkeep_running=true\n").keep_running);
    }
}
