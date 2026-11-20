//! Whether the app may stay running without a window, and what happens then. The decisions are
//! pure and tested below; main.rs only acts on them. The rule behind all of them: a process with
//! no window must always have a way back, so a window is never hidden, and a login start never
//! skips it, unless the user can bring it back.

/// The argument the system's login entry starts the app with.
pub const LOGIN_ARG: &str = "--from-login";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

pub const OS: Os = if cfg!(target_os = "macos") {
    Os::Mac
} else if cfg!(windows) {
    Os::Windows
} else {
    Os::Linux
};

/// What closing the window does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Close {
    /// The window closes and the app ends.
    Quit,
    /// The window hides and the app keeps running.
    Hide,
    /// The window goes to the taskbar: there is no way to bring a hidden one back.
    Minimize,
}

/// True when a user can bring a hidden window back: the Dock on a Mac, the tray icon elsewhere
/// (`tray` is whether one is showing where the user can click it).
pub fn can_reopen(os: Os, tray: bool) -> bool {
    os == Os::Mac || tray
}

/// True when the app starts without a window: only from the login entry, only when the user
/// asked to keep running, and only when the window can be brought back. A restart the user
/// asked for (Restart to Update) repeats the login entry's argument but is never hidden: they
/// are looking at the app.
pub fn start_hidden(
    from_login: bool,
    restarted: bool,
    keep_running: bool,
    can_reopen: bool,
) -> bool {
    from_login && !restarted && keep_running && can_reopen
}

pub fn on_close(keep_running: bool, can_reopen: bool) -> Close {
    match (keep_running, can_reopen) {
        (false, _) => Close::Quit,
        (true, true) => Close::Hide,
        (true, false) => Close::Minimize,
    }
}

/// True when the app was started by the login entry.
pub fn from_login(args: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    args.into_iter().any(|arg| arg.as_ref() == LOGIN_ARG)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Os; 3] = [Os::Mac, Os::Windows, Os::Linux];

    #[test]
    fn the_dock_always_brings_a_window_back_and_elsewhere_only_a_tray_does() {
        for os in ALL {
            assert!(can_reopen(os, true));
            assert_eq!(can_reopen(os, false), os == Os::Mac);
        }
    }

    #[test]
    fn closing_by_platform_setting_and_tray() {
        // (os, keep running, tray, what closing does)
        let table = [
            (Os::Mac, false, false, Close::Quit),
            (Os::Mac, false, true, Close::Quit),
            (Os::Mac, true, false, Close::Hide),
            (Os::Mac, true, true, Close::Hide),
            (Os::Windows, false, false, Close::Quit),
            (Os::Windows, false, true, Close::Quit),
            (Os::Windows, true, false, Close::Minimize),
            (Os::Windows, true, true, Close::Hide),
            (Os::Linux, false, false, Close::Quit),
            (Os::Linux, false, true, Close::Quit),
            (Os::Linux, true, false, Close::Minimize),
            (Os::Linux, true, true, Close::Hide),
        ];
        for (os, keep, tray, expected) in table {
            assert_eq!(
                on_close(keep, can_reopen(os, tray)),
                expected,
                "{os:?} keep={keep} tray={tray}"
            );
        }
    }

    #[test]
    fn a_login_start_is_hidden_only_with_the_setting_and_a_way_back() {
        for os in ALL {
            for tray in [false, true] {
                for keep in [false, true] {
                    for login in [false, true] {
                        for restarted in [false, true] {
                            let expected = login && !restarted && keep && (os == Os::Mac || tray);
                            assert_eq!(
                                start_hidden(login, restarted, keep, can_reopen(os, tray)),
                                expected,
                                "{os:?} tray={tray} keep={keep} login={login} restarted={restarted}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_window_that_stays_hidden_always_has_a_way_back() {
        for os in ALL {
            for tray in [false, true] {
                let reopen = can_reopen(os, tray);
                assert!(on_close(true, reopen) != Close::Hide || reopen);
                assert!(!start_hidden(true, false, true, reopen) || reopen);
            }
        }
    }

    #[test]
    fn the_login_argument_is_found_among_the_others() {
        assert!(from_login(["dozo", "--from-login"]));
        assert!(!from_login(["dozo"]));
        assert!(!from_login(["dozo", "--from-login-not"]));
    }
}
