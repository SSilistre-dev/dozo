//! The password manager adapter: the one place that knows which program holds the person's logins
//! and how to ask it. Everything else sees an opaque provider id, a list of logins (title and
//! site) and, on demand, one value in memory (`Secret`). The program is found only at fixed
//! absolute paths (never `PATH`, never the home folder), run with an argument list (no shell), a
//! cleared environment, a time limit and a cap on what it may print. What it prints on stderr is
//! read to tell "locked" from "failed" and then dropped: it is never logged or returned, so a
//! value that ends up there cannot surface.

use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

pub type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Why a read or a list did not give anything. Only this class is ever passed on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Not signed in, the approval was refused or dismissed, or nobody answered in time.
    Locked,
    /// Anything else.
    Failed,
}

/// Which value of a login to read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Username,
    Password,
    Code,
}

/// A login as the person picks it: its title and its site. `item` and `vault` are the program's
/// own ids, never shown.
#[derive(Clone, Debug, PartialEq)]
pub struct Login {
    pub item: String,
    pub vault: String,
    pub title: String,
    /// The login's website as an https origin.
    pub site: String,
}

/// One value, in memory only. Overwritten when dropped; never printed.
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(bytes: Vec<u8>) -> Self {
        Secret(bytes)
    }

    pub fn as_str(&self) -> Option<&str> {
        std::str::from_utf8(&self.0).ok()
    }

    /// Overwrites the bytes. The compiler is told the zeros are read, so the writes stay.
    pub fn wipe(&mut self) {
        self.0.fill(0);
        std::hint::black_box(&self.0);
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.wipe();
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// What the rest of the app needs from the program; tests put a fake in its place.
pub trait PasswordManager: Send + Sync {
    fn logins(&self) -> Fut<'_, Result<Vec<Login>, Failure>>;
    fn read(&self, item: &str, vault: &str, part: Part) -> Fut<'_, Result<Secret, Failure>>;
}

/// The program's id shape: 26 lower-case letters and digits.
pub fn valid_id(id: &str) -> bool {
    id.len() == 26
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

/// The variables the program needs to reach its desktop app (and every `LC_*`); nothing else of
/// this app's environment, nothing that could change what it loads or where it looks.
const CLI_ENV: &[&str] = &[
    "HOME",
    "USER",
    "LANG",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
];

fn cli_env(vars: impl Iterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    vars.filter(|(name, _)| {
        let name = name.to_string_lossy();
        CLI_ENV.contains(&name.as_ref()) || name.starts_with("LC_")
    })
    .collect()
}

/// What a value or a code may print: far more than either is.
const MAX_VALUE_OUTPUT: usize = 64 * 1024;
/// What the list of logins may print.
const MAX_LIST_OUTPUT: usize = 8 * 1024 * 1024;
/// How much of stderr is kept to tell "locked" from "failed"; the rest is read and dropped.
const MAX_STDERR: usize = 8 * 1024;
const MAX_LOGINS: usize = 500;
const MAX_TITLE: usize = 200;

/// The program's process group (Unix), ended with it unless the program ended by itself: on a
/// timeout, a failure, or when the caller stops waiting. Elsewhere only the program is ended.
struct Group(Option<u32>);

impl Group {
    fn end(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.and_then(|pid| i32::try_from(pid).ok()) {
            // SAFETY: killpg only sends a signal; the group is the one this call made.
            unsafe { libc::killpg(pid, libc::SIGKILL) };
        }
        #[cfg(not(unix))]
        let _ = self.0;
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.end();
    }
}

pub struct Cli {
    program: PathBuf,
    timeout: Duration,
}

/// Where the system installs the program.
#[cfg(target_os = "macos")]
fn candidates() -> &'static [&'static str] {
    &["/opt/homebrew/bin/op", "/usr/local/bin/op"]
}

#[cfg(target_os = "linux")]
fn candidates() -> &'static [&'static str] {
    &["/usr/bin/op", "/usr/local/bin/op"]
}

/// Not offered on Windows yet.
#[cfg(windows)]
fn candidates() -> &'static [&'static str] {
    &[]
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn executable(path: &Path) -> bool {
    path.is_file()
}

/// The program, where the system installs it.
pub fn find() -> Option<Cli> {
    candidates()
        .iter()
        .map(PathBuf::from)
        .find(|path| executable(path))
        .map(Cli::at)
}

impl Cli {
    pub fn at(program: PathBuf) -> Self {
        Cli {
            program,
            timeout: Duration::from_secs(10),
        }
    }

    /// Runs the program with `args` and answers what it printed on stdout, at most `cap` bytes.
    /// Never on a shell, never with more environment than `CLI_ENV`.
    async fn run(&self, args: &[&str], cap: usize) -> Result<Secret, Failure> {
        let mut command = Command::new(&self.program);
        command
            .args(args)
            .env_clear()
            .envs(cli_env(std::env::vars_os()))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Its own process group, so what it starts can be ended with it.
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| Failure::Failed)?;
        let mut group = Group(child.id());
        let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take())
        else {
            return Err(Failure::Failed);
        };
        // Read to the end and kept only in part: a program that fills stderr must not block.
        let errors = tokio::spawn(async move {
            let mut kept = Secret::new(Vec::new());
            let mut chunk = [0u8; 4096];
            while let Ok(read) = stderr.read(&mut chunk).await {
                if read == 0 {
                    break;
                }
                let room = MAX_STDERR.saturating_sub(kept.0.len());
                kept.0.extend_from_slice(&chunk[..read.min(room)]);
            }
            kept
        });
        let work = async {
            let mut out = Secret::new(Vec::new());
            let mut chunk = [0u8; 4096];
            loop {
                let read = stdout.read(&mut chunk).await.map_err(|_| Failure::Failed)?;
                if read == 0 {
                    break;
                }
                out.0.extend_from_slice(&chunk[..read]);
                chunk.fill(0);
                if out.0.len() > cap {
                    return Err(Failure::Failed);
                }
            }
            let status = child.wait().await.map_err(|_| Failure::Failed)?;
            Ok((out, status))
        };
        let outcome = tokio::time::timeout(self.timeout, work).await;
        let (out, status) = match outcome {
            Ok(Ok(done)) => done,
            Ok(Err(failure)) => {
                group.end();
                let _ = child.kill().await;
                errors.abort();
                return Err(failure);
            }
            Err(_) => {
                group.end();
                let _ = child.kill().await;
                errors.abort();
                return Err(Failure::Locked);
            }
        };
        // It ended by itself: what it left behind is its own business.
        group.0 = None;
        let kept = errors.await.unwrap_or_else(|_| Secret::new(Vec::new()));
        if status.success() {
            return Ok(out);
        }
        Err(if asks_to_sign_in(&kept.0) {
            Failure::Locked
        } else {
            Failure::Failed
        })
    }
}

/// Whether what the program said on stderr means it is not signed in or the person did not
/// approve. Only this answer leaves: the text itself does not.
fn asks_to_sign_in(stderr: &[u8]) -> bool {
    let text = String::from_utf8_lossy(stderr).to_lowercase();
    [
        "not currently signed in",
        "not signed in",
        "sign in",
        "signed in",
        "authoriz",
        "locked",
        "dismissed",
        "cancel",
    ]
    .iter()
    .any(|hint| text.contains(hint))
}

/// The login's website: the primary one, else the first, as an https origin; none for any other.
fn https_site(urls: &Value) -> Option<String> {
    let urls = urls.as_array()?;
    let primary = urls.iter().find(|url| url["primary"] == true);
    let href = primary.or_else(|| urls.first())?["href"].as_str()?;
    let url = tauri::Url::parse(href).ok()?;
    (url.scheme() == "https" && url.host_str().is_some())
        .then(|| url.origin().ascii_serialization())
}

/// What a person sees of a title: no control characters, no longer than a line.
fn shown_title(title: &str) -> String {
    let title: String = title.chars().filter(|c| !c.is_control()).collect();
    title.trim().chars().take(MAX_TITLE).collect()
}

fn parse_logins(output: &[u8]) -> Result<Vec<Login>, Failure> {
    let listed: Value = serde_json::from_slice(output).map_err(|_| Failure::Failed)?;
    let mut logins: Vec<Login> = listed
        .as_array()
        .ok_or(Failure::Failed)?
        .iter()
        .filter_map(|entry| {
            let item = entry["id"].as_str().filter(|id| valid_id(id))?;
            let vault = entry["vault"]["id"].as_str().filter(|id| valid_id(id))?;
            let title = shown_title(entry["title"].as_str()?);
            Some(Login {
                item: item.to_owned(),
                vault: vault.to_owned(),
                title: (!title.is_empty()).then_some(title)?,
                site: https_site(&entry["urls"])?,
            })
        })
        .take(MAX_LOGINS)
        .collect();
    logins.sort_by_key(|login| login.title.to_lowercase());
    Ok(logins)
}

/// The `value` of the one field the program printed, as an object or as the one entry of a list.
fn parse_value(mut output: Secret, label: &str) -> Result<Secret, Failure> {
    let parsed: Value = serde_json::from_slice(&output.0).map_err(|_| Failure::Failed)?;
    output.wipe();
    let mut field = match parsed {
        Value::Array(fields) => fields
            .into_iter()
            .find(|field| field["label"] == label)
            .ok_or(Failure::Failed)?,
        object => object,
    };
    match field["value"].take() {
        Value::String(value) if !value.is_empty() => Ok(Secret::new(value.into_bytes())),
        _ => Err(Failure::Failed),
    }
}

impl PasswordManager for Cli {
    fn logins(&self) -> Fut<'_, Result<Vec<Login>, Failure>> {
        Box::pin(async move {
            let args = ["item", "list", "--categories", "Login", "--format", "json"];
            parse_logins(&self.run(&args, MAX_LIST_OUTPUT).await?.0)
        })
    }

    fn read(&self, item: &str, vault: &str, part: Part) -> Fut<'_, Result<Secret, Failure>> {
        let (item, vault) = (item.to_owned(), vault.to_owned());
        Box::pin(async move {
            if !valid_id(&item) || !valid_id(&vault) {
                return Err(Failure::Failed);
            }
            if part == Part::Code {
                let args = ["item", "get", &item, "--vault", &vault, "--otp"];
                let mut out = self.run(&args, MAX_VALUE_OUTPUT).await?;
                while out.0.last().is_some_and(u8::is_ascii_whitespace) {
                    out.0.pop();
                }
                return if out.0.is_empty() {
                    Err(Failure::Failed)
                } else {
                    Ok(out)
                };
            }
            let label = if part == Part::Username {
                "username"
            } else {
                "password"
            };
            let fields = format!("label={label}");
            let args = [
                "item", "get", &item, "--vault", &vault, "--fields", &fields, "--reveal",
                "--format", "json",
            ];
            parse_value(self.run(&args, MAX_VALUE_OUTPUT).await?, label)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ITEM: &str = "abcdefghij0123456789abcdef";
    #[cfg(unix)]
    const VAULT: &str = "zyxwvutsrq9876543210zyxwvu";

    #[test]
    fn an_item_id_is_26_lower_case_letters_and_digits() {
        assert!(valid_id(ITEM));
        for bad in [
            "",
            "abc",
            "ABCDEFGHIJ0123456789ABCDEF",
            "abcdefghij0123456789abcde-",
            "abcdefghij0123456789abcdefg",
            "abcdefghij0123456789abcde ",
            "--vault",
        ] {
            assert!(!valid_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_secret_is_overwritten_and_never_printed() {
        let mut secret = Secret::new(b"hunter2".to_vec());
        assert_eq!(format!("{secret:?}"), "Secret(..)");
        secret.wipe();
        assert!(secret.0.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn only_what_the_program_needs_reaches_it() {
        let os = |text: &str| std::ffi::OsString::from(text);
        let kept = cli_env(
            [
                ("HOME", "/home/a"),
                ("PATH", "/tmp/evil"),
                ("LC_ALL", "C"),
                ("LD_PRELOAD", "/tmp/x.so"),
                ("XDG_RUNTIME_DIR", "/run/user/1"),
                ("OP_SERVICE_ACCOUNT_TOKEN", "t"),
                ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/x"),
            ]
            .into_iter()
            .map(|(name, value)| (os(name), os(value))),
        );
        let names: Vec<String> = kept
            .iter()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            [
                "HOME",
                "LC_ALL",
                "XDG_RUNTIME_DIR",
                "DBUS_SESSION_BUS_ADDRESS"
            ]
        );
    }

    /// A fake program: a script in its own folder that records how it was called.
    #[cfg(unix)]
    struct Fake {
        dir: PathBuf,
        cli: Cli,
    }

    #[cfg(unix)]
    impl Fake {
        fn new(name: &str, body: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!("dozo-pm-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let program = dir.join("op");
            let text = format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}/args'\n{body}\n",
                dir.display()
            );
            std::fs::write(&program, text).unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
            let mut cli = Cli::at(program);
            cli.timeout = Duration::from_secs(3);
            Fake { dir, cli }
        }

        fn args(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.join("args"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }
    }

    #[cfg(unix)]
    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn logins_are_listed_by_title_and_https_site_only() {
        let listing = r#"[
          {"id":"abcdefghij0123456789abcdef","title":"Bank","vault":{"id":"zyxwvutsrq9876543210zyxwvu"},
           "urls":[{"href":"https://other.example.com/x"},{"primary":true,"href":"https://Bank.Example.com/login?a=1"}]},
          {"id":"abcdefghij0123456789abcdeg","title":"Plain","vault":{"id":"zyxwvutsrq9876543210zyxwvu"},
           "urls":[{"primary":true,"href":"http://plain.example.com/"}]},
          {"id":"NOT-AN-ID","title":"Bad","vault":{"id":"zyxwvutsrq9876543210zyxwvu"},
           "urls":[{"primary":true,"href":"https://bad.example.com/"}]},
          {"id":"abcdefghij0123456789abcdeh","title":"No\u0007 site\nname","vault":{"id":"zyxwvutsrq9876543210zyxwvu"}}
        ]"#;
        let fake = Fake::new("list", &format!("cat <<'JSON'\n{listing}\nJSON"));
        let logins = fake.cli.logins().await.unwrap();
        assert_eq!(
            logins,
            [Login {
                item: ITEM.to_owned(),
                vault: VAULT.to_owned(),
                title: "Bank".to_owned(),
                site: "https://bank.example.com".to_owned(),
            }]
        );
        assert_eq!(
            fake.args(),
            ["item", "list", "--categories", "Login", "--format", "json"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_value_is_read_with_a_fixed_argument_list() {
        let fake = Fake::new(
            "read",
            r#"printf '%s\n' '{"id":"password","label":"password","value":"p\"w\\d"}'"#,
        );
        let secret = fake.cli.read(ITEM, VAULT, Part::Password).await.unwrap();
        assert_eq!(secret.as_str(), Some("p\"w\\d"));
        assert_eq!(
            fake.args(),
            [
                "item",
                "get",
                ITEM,
                "--vault",
                VAULT,
                "--fields",
                "label=password",
                "--reveal",
                "--format",
                "json"
            ]
        );
        let fake = Fake::new("user", r#"echo '[{"label":"username","value":"ann"}]'"#);
        let secret = fake.cli.read(ITEM, VAULT, Part::Username).await.unwrap();
        assert_eq!(secret.as_str(), Some("ann"));
        assert_eq!(fake.args()[6], "label=username");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_code_is_read_as_one_time_code_text() {
        let fake = Fake::new("code", "echo 123456");
        let secret = fake.cli.read(ITEM, VAULT, Part::Code).await.unwrap();
        assert_eq!(secret.as_str(), Some("123456"));
        assert_eq!(
            fake.args(),
            ["item", "get", ITEM, "--vault", VAULT, "--otp"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_id_of_the_wrong_shape_never_reaches_the_program() {
        let fake = Fake::new("badid", "echo x");
        for (item, vault) in [("--help", VAULT), (ITEM, "a b"), ("", ""), (ITEM, "UP")] {
            let read = fake.cli.read(item, vault, Part::Password).await;
            assert_eq!(read.unwrap_err(), Failure::Failed);
        }
        assert!(
            fake.args().is_empty(),
            "the program was run: {:?}",
            fake.args()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_program_that_does_not_answer_in_time_is_locked() {
        let mut fake = Fake::new("slow", "sleep 5; echo late");
        fake.cli.timeout = Duration::from_millis(300);
        let started = std::time::Instant::now();
        let read = fake.cli.read(ITEM, VAULT, Part::Password).await;
        assert_eq!(read.unwrap_err(), Failure::Locked);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    /// Whether the process is running: a process that ended and is not yet reaped is not.
    #[cfg(target_os = "linux")]
    fn running(pid: u32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
            !stat
                .rsplit(')')
                .next()
                .unwrap_or("")
                .trim_start()
                .starts_with('Z')
        })
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_timeout_ends_what_the_program_started_too() {
        let mut fake = Fake::new(
            "tree",
            "sleep 30 &\necho $! > \"$(dirname \"$0\")/child\"\nsleep 30",
        );
        fake.cli.timeout = Duration::from_millis(300);
        let read = fake.cli.read(ITEM, VAULT, Part::Password).await;
        assert_eq!(read.unwrap_err(), Failure::Locked);
        let child: u32 = std::fs::read_to_string(fake.dir.join("child"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(!running(child), "the program's child outlived the timeout");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_beyond_64_kib_is_refused() {
        let fake = Fake::new("huge", "head -c 200000 /dev/zero | tr '\\0' 'a'");
        let read = fake.cli.read(ITEM, VAULT, Part::Code).await;
        assert_eq!(read.unwrap_err(), Failure::Failed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failing_program_is_failed_or_locked_and_its_stderr_never_surfaces() {
        let fake = Fake::new("exit", "echo 'boom hunter2-in-stderr' >&2; exit 3");
        let read = fake.cli.read(ITEM, VAULT, Part::Password).await;
        assert_eq!(read.as_ref().unwrap_err(), &Failure::Failed);
        assert!(!format!("{read:?}").contains("hunter2"));
        let fake = Fake::new(
            "locked",
            "echo '[ERROR] you are not currently signed in hunter2-in-stderr' >&2; exit 1",
        );
        let read = fake.cli.read(ITEM, VAULT, Part::Password).await;
        assert_eq!(read.as_ref().unwrap_err(), &Failure::Locked);
        assert!(!format!("{read:?}").contains("hunter2"));
        let fake = Fake::new("empty", "echo '{\"value\":\"\"}'");
        assert_eq!(
            fake.cli
                .read(ITEM, VAULT, Part::Password)
                .await
                .unwrap_err(),
            Failure::Failed
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_program_runs_with_a_cleared_environment() {
        let fake = Fake::new("env", "/usr/bin/env > \"$(dirname \"$0\")/env\"; echo 1");
        fake.cli.read(ITEM, VAULT, Part::Code).await.unwrap();
        let seen = std::fs::read_to_string(fake.dir.join("env")).unwrap();
        assert!(
            !seen
                .lines()
                .any(|line| line.starts_with("CARGO") || line.starts_with("PATH=")),
            "{seen}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_program_is_found_only_at_fixed_absolute_paths() {
        for path in candidates() {
            assert!(std::path::Path::new(path).is_absolute(), "{path}");
        }
        assert!(
            !candidates()
                .iter()
                .any(|path| path.contains("..") || path.contains('~'))
        );
        let fake = Fake::new("found", "echo");
        assert!(executable(&fake.cli.program));
        assert!(!executable(&fake.dir));
        assert!(!executable(&fake.dir.join("missing")));
    }
}
