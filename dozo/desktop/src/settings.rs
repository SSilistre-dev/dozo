//! What the app saves between launches, in one small file in the app's config folder: the server
//! address on the first line (the whole file, before the two switches existed) and one
//! `name=true|false` line per switch. A missing switch is off. `this_computer=true` says the server
//! is the one this app runs on this computer (`stack.rs`); its address is then the one it last
//! started at. Tested below.

use std::path::Path;

use tauri::Url;

use crate::server::parse_server;

const OPEN_AT_LOGIN: &str = "open_at_login=";
const KEEP_RUNNING: &str = "keep_running=";
const THIS_COMPUTER: &str = "this_computer=";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settings {
    pub server: Option<Url>,
    /// Start when the user signs in to the computer.
    pub open_at_login: bool,
    /// Closing the window leaves the app running.
    pub keep_running: bool,
    /// The app runs the server itself, on this computer.
    pub this_computer: bool,
}

/// Reads the file. The address is checked again: the file may have been edited by hand.
pub fn parse(text: &str) -> Settings {
    let mut settings = Settings::default();
    let mut address_seen = false;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some(value) = line.strip_prefix(OPEN_AT_LOGIN) {
            settings.open_at_login = value.trim() == "true";
        } else if let Some(value) = line.strip_prefix(KEEP_RUNNING) {
            settings.keep_running = value.trim() == "true";
        } else if let Some(value) = line.strip_prefix(THIS_COMPUTER) {
            settings.this_computer = value.trim() == "true";
        } else if !address_seen {
            // Only the first such line is the address; a bad one leaves it unset, and no later
            // line takes its place.
            address_seen = true;
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
    if settings.this_computer {
        text.push_str(&format!("{THIS_COMPUTER}true\n"));
    }
    text
}

/// Writes the file whole or not at all: to a file beside it first, then renamed over it, so a
/// crash or a full disk never leaves a cut-off file where the server address was.
pub fn save(file: &Path, settings: &Settings) -> std::io::Result<()> {
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = std::path::PathBuf::from(temporary);
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder)?;
    }
    std::fs::write(&temporary, render(settings))?;
    std::fs::rename(&temporary, file).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
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
                for this_computer in [false, true] {
                    let settings = Settings {
                        server: server.clone(),
                        open_at_login,
                        keep_running,
                        this_computer,
                    };
                    assert_eq!(parse(&render(&settings)), settings);
                }
            }
        }
    }

    #[test]
    fn the_address_stays_the_first_line() {
        let settings = Settings {
            server: server(),
            open_at_login: true,
            keep_running: true,
            this_computer: true,
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

    #[test]
    fn only_the_first_other_line_can_be_the_address() {
        assert_eq!(
            parse("not an address\nhttps://dozo.example.com/\n").server,
            None
        );
    }

    fn folder(name: &str) -> std::path::PathBuf {
        let folder =
            std::env::temp_dir().join(format!("dozo-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        folder
    }

    #[test]
    fn saving_replaces_the_file_whole_and_leaves_nothing_beside_it() {
        let folder = folder("save");
        let file = folder.join("server");
        let old = Settings {
            server: server(),
            ..Settings::default()
        };
        save(&file, &old).unwrap();
        let new = Settings {
            keep_running: true,
            ..old
        };
        save(&file, &new).unwrap();
        assert_eq!(parse(&std::fs::read_to_string(&file).unwrap()), new);
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_failed_save_keeps_the_file_that_was_there() {
        let folder = folder("fail");
        let file = folder.join("server");
        let old = Settings {
            server: server(),
            ..Settings::default()
        };
        save(&file, &old).unwrap();
        // The place the new file is written first is taken by a folder: the write fails.
        std::fs::create_dir(folder.join("server.tmp")).unwrap();
        assert!(save(&file, &Settings::default()).is_err());
        assert_eq!(parse(&std::fs::read_to_string(&file).unwrap()), old);
        let _ = std::fs::remove_dir_all(&folder);
    }
}
