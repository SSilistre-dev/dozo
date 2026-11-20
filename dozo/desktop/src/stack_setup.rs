//! What the local server keeps between starts, other than its database: the secrets made on the
//! first start, the ports, the lock that keeps a second app off the same folder, and the check
//! for the one system library Linux must have. Tested below.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::Path;

/// Each a random 32-byte hex string. Kept in `<root>/secrets`, readable by this user only.
pub const SECRET_KEYS: [&str; 6] = [
    "PG_OWNER_PASSWORD",
    "PG_APP_PASSWORD",
    "BETTER_AUTH_SECRET",
    "SCREEN_PROXY_SECRET",
    "ENCRYPTION_KEY",
    "STACK_TOKEN",
];

#[derive(Debug, PartialEq)]
pub struct Secrets(Vec<(String, String)>);

impl Secrets {
    pub fn get(&self, key: &str) -> &str {
        self.0
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
            .expect("every key is made on load")
    }
}

/// Reads the secrets, making any that are missing (all of them on the first start). A value is
/// never replaced: a new `ENCRYPTION_KEY` would lose what the old one sealed.
pub fn secrets(file: &Path) -> io::Result<Secrets> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    let mut values: Vec<(String, String)> = text
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect();
    let mut added = false;
    for key in SECRET_KEYS {
        if !values.iter().any(|(name, _)| name == key) {
            values.push((key.to_owned(), random_hex()?));
            added = true;
        }
    }
    if added {
        let text: String = values
            .iter()
            .map(|(key, value)| format!("{key}={value}\n"))
            .collect();
        write_private(file, text.as_bytes())?;
    }
    Ok(Secrets(values))
}

fn random_hex() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Writes a file only this user can read, whole or not at all.
pub fn write_private(file: &Path, body: &[u8]) -> io::Result<()> {
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(".tmp");
    let _ = fs::remove_file(&temporary);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut out = options.open(&temporary)?;
    out.write_all(body)?;
    out.sync_all()?;
    fs::rename(&temporary, file)
}

/// The three ports, all on 127.0.0.1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ports {
    pub postgres: u16,
    pub api: u16,
    pub web: u16,
}

#[derive(Debug)]
pub enum PortError {
    /// The web port is the address the app saved and the pages' origin: it is never moved, so
    /// another program on it stops the start.
    WebTaken(u16),
    Io(io::Error),
}

/// The saved ports, with Postgres and the API moved to a free port when theirs is taken. The first
/// start picks all three from the ports the system says are free.
pub fn ports(file: &Path) -> Result<Ports, PortError> {
    let saved = saved_ports(file).map(|ports| (ports.postgres, ports.api, ports.web));
    let (postgres, api, web) = match saved {
        Some((postgres, api, web)) => {
            if !free(web) {
                return Err(PortError::WebTaken(web));
            }
            let postgres = keep_or_pick(postgres, &[web])?;
            let api = keep_or_pick(api, &[web, postgres])?;
            (postgres, api, web)
        }
        None => {
            let web = pick(&[]).map_err(PortError::Io)?;
            let postgres = pick(&[web]).map_err(PortError::Io)?;
            let api = pick(&[web, postgres]).map_err(PortError::Io)?;
            (postgres, api, web)
        }
    };
    let ports = Ports { postgres, api, web };
    let text = format!("postgres={postgres}\napi={api}\nweb={web}\n");
    if saved != Some((postgres, api, web)) {
        fs::write(file, text).map_err(PortError::Io)?;
    }
    Ok(ports)
}

fn keep_or_pick(port: u16, taken: &[u16]) -> Result<u16, PortError> {
    if !taken.contains(&port) && free(port) {
        Ok(port)
    } else {
        pick(taken).map_err(PortError::Io)
    }
}

fn free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// A port the system says is free now, not one of `taken`.
fn pick(taken: &[u16]) -> io::Result<u16> {
    for _ in 0..20 {
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
            .local_addr()?
            .port();
        if !taken.contains(&port) {
            return Ok(port);
        }
    }
    Err(io::Error::other("no free port"))
}

/// The ports the last start used, if any.
pub fn saved_ports(file: &Path) -> Option<Ports> {
    let text = fs::read_to_string(file).ok()?;
    let get = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .and_then(|value| value.trim().parse::<u16>().ok())
            .filter(|port| *port > 0)
    };
    Some(Ports {
        postgres: get("postgres")?,
        api: get("api")?,
        web: get("web")?,
    })
}

/// Held for as long as the server runs from this folder, and by its processes too (they inherit
/// it, `stack_os.rs`), so a second app cannot start one beside it or beside what is left of it.
pub fn lock(file: &Path) -> io::Result<Option<File>> {
    let handle = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(file)?;
    match handle.try_lock() {
        Ok(()) => Ok(Some(handle)),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(fs::TryLockError::Error(error)) => Err(error),
    }
}

/// Prisma's migration engine on Linux loads the system OpenSSL 3, which the bundle does not
/// carry (`dozo/server-bundle/run.sh`, `preflight`).
#[cfg(target_os = "linux")]
pub fn has_libssl3() -> bool {
    let mut folders = vec![
        "/lib".to_owned(),
        "/lib64".to_owned(),
        "/usr/lib".to_owned(),
        "/usr/lib64".to_owned(),
    ];
    for parent in ["/lib", "/usr/lib"] {
        if let Ok(entries) = fs::read_dir(parent) {
            folders.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.to_string_lossy().ends_with("-linux-gnu"))
                    .map(|path| path.to_string_lossy().into_owned()),
            );
        }
    }
    folders
        .iter()
        .any(|folder| Path::new(folder).join("libssl.so.3").exists())
        || std::process::Command::new("/sbin/ldconfig")
            .arg("-p")
            .output()
            .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains("libssl.so.3 "))
}

#[cfg(not(target_os = "linux"))]
pub fn has_libssl3() -> bool {
    true
}

/// Makes the unpacked Postgres run here. Its Linux build carries a `libstdc++` that needs glibc
/// 2.36, newer than Ubuntu 22.04's; the programs themselves need 2.34, and the system's own
/// `libstdc++` has what they use. So where Postgres does not run as unpacked, the carried one is
/// set aside and the system's is used; if that does not run either, the carried one goes back.
pub fn fit_postgres(postgres: &Path) -> Result<(), String> {
    let runs = || {
        std::process::Command::new(postgres.join("bin").join(if cfg!(windows) {
            "postgres.exe"
        } else {
            "postgres"
        }))
        .arg("--version")
        .env_clear()
        .output()
        .map_err(|error| error.to_string())
        .and_then(|out| {
            out.status
                .success()
                .then_some(())
                .ok_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_owned())
        })
    };
    let Err(first) = runs() else {
        return Ok(());
    };
    let carried = postgres.join("lib/libstdc++.so.6");
    let aside = postgres.join("lib/libstdc++.so.6.unused");
    if !cfg!(target_os = "linux") || fs::rename(&carried, &aside).is_err() {
        return Err(first);
    }
    runs().map_err(|second| {
        let _ = fs::rename(&aside, &carried);
        format!("{first}; with the system's libstdc++: {second}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stack_fetch::tests::scratch;

    #[test]
    fn secrets_are_made_once_private_and_kept() {
        let dir = scratch("secrets");
        let file = dir.join("secrets");
        let first = secrets(&file).unwrap();
        for key in SECRET_KEYS {
            assert_eq!(first.get(key).len(), 64);
        }
        assert_ne!(first.get("ENCRYPTION_KEY"), first.get("STACK_TOKEN"));
        assert_eq!(secrets(&file).unwrap(), first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_missing_secret_is_added_and_the_others_stay() {
        let dir = scratch("secrets-add");
        let file = dir.join("secrets");
        fs::write(&file, "ENCRYPTION_KEY=kept\n").unwrap();
        let secrets = secrets(&file).unwrap();
        assert_eq!(secrets.get("ENCRYPTION_KEY"), "kept");
        assert_eq!(secrets.get("STACK_TOKEN").len(), 64);
        assert!(
            fs::read_to_string(&file)
                .unwrap()
                .starts_with("ENCRYPTION_KEY=kept\n")
        );
    }

    #[test]
    fn ports_are_free_distinct_and_kept() {
        let dir = scratch("ports");
        let file = dir.join("ports");
        let first = ports(&file).unwrap();
        assert!(first.postgres != first.api && first.api != first.web);
        assert!(first.postgres != first.web);
        assert_eq!(ports(&file).unwrap(), first);
    }

    #[test]
    fn a_taken_port_moves_except_the_web_one() {
        let dir = scratch("ports-taken");
        let file = dir.join("ports");
        let first = ports(&file).unwrap();
        let held = TcpListener::bind((Ipv4Addr::LOCALHOST, first.api)).unwrap();
        let second = ports(&file).unwrap();
        assert_ne!(second.api, first.api);
        assert_eq!(second.web, first.web);
        drop(held);
        let _web = TcpListener::bind((Ipv4Addr::LOCALHOST, first.web)).unwrap();
        assert!(matches!(ports(&file), Err(PortError::WebTaken(port)) if port == first.web));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn postgres_falls_back_to_the_system_libstdcxx_only_when_it_must() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("fit");
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::create_dir_all(dir.join("lib")).unwrap();
        let postgres = dir.join("bin/postgres");
        let write = |body: &str| {
            fs::write(&postgres, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&postgres, fs::Permissions::from_mode(0o755)).unwrap();
        };
        let carried = dir.join("lib/libstdc++.so.6");
        // Runs as unpacked: nothing is moved.
        fs::write(&carried, "").unwrap();
        write("exit 0");
        fit_postgres(&dir).unwrap();
        assert!(carried.exists());
        // Runs only without the carried library: it is set aside.
        write(
            "[ -e \"$(dirname \"$0\")/../lib/libstdc++.so.6\" ] && { echo GLIBC_2.36 >&2; exit 1; }; exit 0",
        );
        fit_postgres(&dir).unwrap();
        assert!(!carried.exists());
        // Runs neither way: it goes back, and the error says both.
        fs::rename(dir.join("lib/libstdc++.so.6.unused"), &carried).unwrap();
        write("echo broken >&2; exit 1");
        assert_eq!(
            fit_postgres(&dir).unwrap_err(),
            "broken; with the system's libstdc++: broken"
        );
        assert!(carried.exists());
    }

    #[test]
    fn only_one_holder_of_the_folder() {
        let dir = scratch("lock");
        let file = dir.join("stack.lock");
        let first = lock(&file).unwrap();
        assert!(first.is_some());
        assert!(lock(&file).unwrap().is_none());
        drop(first);
        assert!(lock(&file).unwrap().is_some());
    }
}
