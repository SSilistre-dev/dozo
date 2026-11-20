//! Backing up the server on this computer to one sealed file, and restoring one, with the bundle's
//! own command (`dozo/server-bundle/README.md`, "Backup and restore"). The password goes to the
//! command on its standard input only: never an argument, a variable or a log line.
//!
//! The command restores into an empty installation only. To restore over one in use, the server
//! is stopped and its data moved aside into `before-restore/<time>/` (renames); the restore goes
//! into the emptied folder. If it fails, what was moved aside comes back, so nothing changed. The
//! last set moved aside is kept after a restore that worked, in case.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::stack_os::{self, Stop};

/// What a restore replaces.
const DATA: [&str; 4] = ["pgdata", "data", "relay", "secrets"];
const ASIDE: &str = "before-restore";
/// Names the set moved aside while a restore is under way, so a restore cut off (the app killed)
/// is undone at the next start instead of that start finding no data and making a new server.
const JOURNAL: &str = "restore";

/// Why a backup or a restore did not happen, as the command says it (`reason`).
#[derive(Clone, Debug, PartialEq)]
pub enum Refusal {
    WrongPassword,
    NotABackup,
    Newer,
    NothingToBackUp,
    /// Anything else: the details are in `logs/backup.log`.
    Failed,
}

impl Refusal {
    fn of(reason: &str) -> Refusal {
        match reason {
            "wrong-password" => Refusal::WrongPassword,
            "damaged" | "not-a-backup" | "no-backup-data" => Refusal::NotABackup,
            "newer" => Refusal::Newer,
            "no-server" => Refusal::NothingToBackUp,
            _ => Refusal::Failed,
        }
    }

    /// The sentence the window shows.
    pub fn message(&self) -> &'static str {
        match self {
            Refusal::WrongPassword => "This password does not open the backup.",
            Refusal::NotABackup => "This file is not a Dozo backup, or it is damaged.",
            Refusal::Newer => "This backup is from a newer Dozo. Update the app first.",
            Refusal::NothingToBackUp => "There is nothing to back up yet.",
            Refusal::Failed => "It did not work. The details are in the log.",
        }
    }
}

/// The bundle's backup command in the installed version, run with its own Node.
pub struct Tool {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub root: PathBuf,
}

impl Tool {
    /// The command in `root`'s current version, if it has one (bundles before 0.11.0-2 do not).
    pub fn of(root: &Path) -> Option<Tool> {
        let version = fs::read_to_string(root.join("current")).ok()?;
        let installed = root.join("versions").join(version.trim());
        let server = installed.join("server/rakazo-server");
        let manifest: Value =
            serde_json::from_str(&fs::read_to_string(server.join("manifest.json")).ok()?).ok()?;
        let entry = server.join(manifest.get("entrypoints")?.get("backup")?.as_str()?);
        let node = if cfg!(windows) {
            installed.join("node/node.exe")
        } else {
            installed.join("node/bin/node")
        };
        (entry.is_file() && node.is_file()).then(|| Tool {
            node,
            entry,
            root: root.to_owned(),
        })
    }

    /// Runs `create` or `restore` on `file` with `password` on its standard input; its one JSON
    /// line, or why not. Its error output goes to `logs/backup.log`.
    async fn run(&self, command: &str, file: &Path, password: &str) -> Result<Value, Refusal> {
        let mut child = Command::new(&self.node);
        child
            .arg(&self.entry)
            .arg(command)
            .arg(file)
            .arg("--home")
            .arg(&self.root)
            .current_dir(self.entry.parent().unwrap_or(&self.root))
            .env_clear()
            .envs(passed_on())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        stack_os::prepare(&mut child, Stop::Terminate, None);
        let mut child = stack_os::spawn(child).await.map_err(|_| Refusal::Failed)?;
        let mut stdin = child.stdin.take().ok_or(Refusal::Failed)?;
        stdin
            .write_all(format!("{password}\n").as_bytes())
            .await
            .map_err(|_| Refusal::Failed)?;
        drop(stdin);
        let (mut out, mut err) = (String::new(), String::new());
        let mut stdout = child.stdout.take().ok_or(Refusal::Failed)?;
        let mut stderr = child.stderr.take().ok_or(Refusal::Failed)?;
        let read = async {
            let _ = tokio::join!(
                stdout.read_to_string(&mut out),
                stderr.read_to_string(&mut err)
            );
            child.wait().await
        };
        // A large server can take long; the command bounds its own steps.
        let status = tokio::time::timeout(Duration::from_secs(3600), read)
            .await
            .map_err(|_| Refusal::Failed)?
            .map_err(|_| Refusal::Failed)?;
        let logs = self.root.join("logs");
        let _ = fs::create_dir_all(&logs);
        let _ = fs::write(
            logs.join("backup.log"),
            format!("{command} exited {status}\n{out}{err}"),
        );
        let answer: Value = out
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str(line).ok())
            .ok_or(Refusal::Failed)?;
        match answer.get("reason").and_then(Value::as_str) {
            Some(reason) => Err(Refusal::of(reason)),
            None if status.success() => Ok(answer),
            None => Err(Refusal::Failed),
        }
    }

    /// Seals the server's data into `file`, running or not.
    pub async fn create(&self, file: &Path, password: &str) -> Result<(), Refusal> {
        self.run("create", file, password).await.map(drop)
    }

    /// Restores `file` into this folder, whatever is in it now: what is there is moved aside
    /// first and comes back if the restore fails. The server must be stopped, and the folder
    /// held (its lock) by the caller.
    /// Returns where the data that was there went, for `undo_restore`.
    pub async fn restore(
        &self,
        file: &Path,
        password: &str,
        stamp: u64,
    ) -> Result<PathBuf, Refusal> {
        // An update a start left unfinished is settled first, so it cannot later put its copy
        // over the restored data.
        crate::stack_update::recover(&self.root).map_err(|_| Refusal::Failed)?;
        let aside = match move_aside(&self.root, stamp) {
            Ok(aside) => aside,
            // Some moved, then one could not: those come back. If even that fails the journal
            // stays, and the next start puts them back before anything else.
            Err(_) => {
                let _ = recover_restore(&self.root);
                return Err(Refusal::Failed);
            }
        };
        let done = match self.run("restore", file, password).await {
            Ok(_) => {
                prune_aside(&self.root, &aside);
                Ok(aside)
            }
            Err(refusal) => {
                put_back(&self.root, &aside).map_err(|_| Refusal::Failed)?;
                Err(refusal)
            }
        };
        fs::remove_file(self.root.join(JOURNAL)).map_err(|_| Refusal::Failed)?;
        done
    }
}

/// The variables the command needs from the app's own environment; nothing else is passed on.
fn passed_on() -> Vec<(String, String)> {
    [
        "PATH",
        "HOME",
        "TMPDIR",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERPROFILE",
    ]
    .into_iter()
    .filter_map(|key| Some((key.to_owned(), std::env::var(key).ok()?)))
    .collect()
}

/// Moves the data out of the way into a folder of its own; returns it.
fn move_aside(root: &Path, stamp: u64) -> io::Result<PathBuf> {
    let aside = (0..)
        .map(|n| root.join(ASIDE).join(format!("{stamp}-{n}")))
        .find(|path| !path.exists())
        .expect("a free name");
    fs::create_dir_all(&aside)?;
    let name = aside.file_name().unwrap_or_default().to_string_lossy();
    crate::stack_setup::write_private(&root.join(JOURNAL), name.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.join(ASIDE), fs::Permissions::from_mode(0o700))?;
    }
    for name in DATA {
        let source = root.join(name);
        if fs::symlink_metadata(&source).is_ok() {
            fs::rename(&source, aside.join(name))?;
        }
    }
    Ok(aside)
}

/// What the failed restore left goes, and the data moved aside comes back.
fn put_back(root: &Path, aside: &Path) -> io::Result<()> {
    for name in DATA {
        let target = root.join(name);
        let kept = aside.join(name);
        if fs::symlink_metadata(&kept).is_err() {
            continue;
        }
        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(&target)?,
            Ok(_) => fs::remove_file(&target)?,
            Err(_) => {}
        }
        fs::rename(&kept, &target)?;
    }
    fs::remove_dir_all(aside)
}

/// A restore the app did not see finish (it was killed): what it left goes, and the data moved
/// aside comes back. Run before anything starts; true when there was one.
pub fn recover_restore(root: &Path) -> io::Result<bool> {
    let Ok(name) = fs::read_to_string(root.join(JOURNAL)) else {
        return Ok(false);
    };
    let aside = root.join(ASIDE).join(name.trim());
    if aside.is_dir() {
        put_back(root, &aside)?;
    }
    fs::remove_file(root.join(JOURNAL))?;
    Ok(true)
}

/// A restore that worked but whose server does not start: the restored data goes aside too,
/// and what was there before comes back.
pub fn undo_restore(root: &Path, aside: &Path, stamp: u64) -> io::Result<()> {
    let restored = move_aside(root, stamp)?;
    put_back(root, aside)?;
    let _ = restored;
    Ok(())
}

/// After a restore that worked, only the newest set moved aside is kept.
fn prune_aside(root: &Path, keep: &Path) {
    for entry in fs::read_dir(root.join(ASIDE))
        .into_iter()
        .flatten()
        .flatten()
    {
        if entry.path() != keep {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::stack_fetch::tests::scratch;
    use std::os::unix::fs::PermissionsExt;

    /// A folder with data, and a stand-in for the bundle's command: it records how it was called
    /// and what came on its input, and answers as `answer` says.
    fn installed(name: &str, answer: &str) -> PathBuf {
        let root = scratch(name);
        let server = root.join("versions/1/server/rakazo-server");
        fs::create_dir_all(&server).unwrap();
        fs::write(
            server.join("manifest.json"),
            r#"{"entrypoints":{"backup":"backup.mjs"}}"#,
        )
        .unwrap();
        fs::write(server.join("backup.mjs"), "").unwrap();
        let node = root.join("versions/1/node/bin/node");
        fs::create_dir_all(node.parent().unwrap()).unwrap();
        fs::write(
            &node,
            format!(
                "#!/bin/sh\necho \"$*\" > \"{root}/called\"\nread line; echo \"$line\" > \"{root}/stdin\"\n{answer}\n",
                root = root.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.join("current"), "1").unwrap();
        fs::create_dir_all(root.join("pgdata")).unwrap();
        fs::write(root.join("pgdata/table"), "rows now").unwrap();
        fs::write(root.join("secrets"), "KEY=now").unwrap();
        root
    }

    fn read(root: &Path, path: &str) -> String {
        fs::read_to_string(root.join(path)).unwrap_or_default()
    }

    #[tokio::test]
    async fn the_password_goes_on_standard_input_only() {
        let root = installed("backup-create", r#"echo '{"created":"f","server":"1"}'"#);
        let tool = Tool::of(&root).unwrap();
        tool.create(&root.join("out.dozo"), "a long secret")
            .await
            .unwrap();
        assert_eq!(read(&root, "stdin").trim(), "a long secret");
        let called = read(&root, "called");
        assert!(called.contains("create"), "{called}");
        assert!(
            called.contains(&format!("--home {}", root.display())),
            "{called}"
        );
        assert!(
            !called.contains("secret"),
            "the password is not an argument"
        );
        assert!(!read(&root, "logs/backup.log").contains("a long secret"));
    }

    #[tokio::test]
    async fn the_reason_becomes_one_sentence() {
        for (reason, refusal) in [
            ("wrong-password", Refusal::WrongPassword),
            ("damaged", Refusal::NotABackup),
            ("newer", Refusal::Newer),
            ("no-server", Refusal::NothingToBackUp),
            ("failed", Refusal::Failed),
        ] {
            let answer = format!(r#"echo '{{"error":"x","reason":"{reason}"}}'; exit 2"#);
            let root = installed(&format!("backup-{reason}"), &answer);
            let tool = Tool::of(&root).unwrap();
            assert_eq!(
                tool.create(&root.join("f"), "password1").await,
                Err(refusal)
            );
        }
        // Without an answer at all.
        let root = installed("backup-silent", "exit 1");
        let tool = Tool::of(&root).unwrap();
        assert_eq!(
            tool.create(&root.join("f"), "password1").await,
            Err(Refusal::Failed)
        );
    }

    #[tokio::test]
    async fn a_restore_over_data_moves_it_aside_and_keeps_it_when_it_works() {
        // The stand-in restores like the real one: into the emptied folder.
        let restore = r#"[ -e "$5/pgdata" ] && { echo '{"error":"x","reason":"not-empty"}'; exit 2; }
            mkdir "$5/pgdata"; echo restored > "$5/pgdata/table"; echo KEY=backup > "$5/secrets"
            echo '{"restored":"f","server":"1","migrate":false}'"#;
        let root = installed("restore-ok", restore);
        let tool = Tool::of(&root).unwrap();
        let aside = tool.restore(&root.join("f"), "password1", 5).await.unwrap();
        assert_eq!(read(&root, "pgdata/table"), "restored\n");
        assert_eq!(read(&root, "secrets"), "KEY=backup\n");
        assert_eq!(read(&root, "before-restore/5-0/pgdata/table"), "rows now");
        assert_eq!(read(&root, "stdin").trim(), "password1");
        // Its server does not start: the data before it comes back, the restored set is kept.
        undo_restore(&root, &aside, 6).unwrap();
        assert_eq!(read(&root, "pgdata/table"), "rows now");
        assert_eq!(read(&root, "before-restore/6-0/pgdata/table"), "restored\n");
    }

    #[tokio::test]
    async fn a_restore_cut_off_is_undone_at_the_next_start() {
        // The app was killed while the command wrote the restored data.
        let root = installed("restore-cut", "");
        let aside = move_aside(&root, 5).unwrap();
        fs::create_dir_all(root.join("pgdata")).unwrap();
        fs::write(root.join("pgdata/table"), "half").unwrap();
        assert!(aside.join("pgdata/table").exists());
        assert!(recover_restore(&root).unwrap());
        assert_eq!(read(&root, "pgdata/table"), "rows now");
        assert_eq!(read(&root, "secrets"), "KEY=now");
        assert!(!root.join("restore").exists());
        assert!(!recover_restore(&root).unwrap(), "nothing the second time");
    }

    #[tokio::test]
    async fn an_unfinished_update_cannot_later_undo_a_restore() {
        let restore = r#"mkdir "$5/pgdata"; echo restored > "$5/pgdata/table"
            echo '{"restored":"f","server":"1","migrate":false}'"#;
        let root = installed("restore-after-update", restore);
        fs::create_dir_all(root.join("versions/2")).unwrap();
        // An update to 2 was cut off after the switch: its journal waits for the next start.
        crate::stack_update::begin(&root, "1", "2", 1).unwrap();
        fs::write(root.join("current"), "2").unwrap();
        let tool = Tool::of(&root).unwrap_or(Tool {
            node: root.join("versions/1/node/bin/node"),
            entry: root.join("versions/1/server/rakazo-server/backup.mjs"),
            root: root.clone(),
        });
        tool.restore(&root.join("f"), "password1", 5).await.unwrap();
        assert!(crate::stack_update::journal(&root).is_none());
        assert_eq!(
            crate::stack_update::recover(&root).unwrap(),
            crate::stack_update::Recovered::Nothing
        );
        assert_eq!(read(&root, "pgdata/table"), "restored\n");
    }

    #[tokio::test]
    async fn a_restore_that_fails_puts_everything_back() {
        // It got as far as writing part of the database, then the password was wrong.
        let restore = r#"mkdir -p "$5/pgdata"; echo half > "$5/pgdata/table"
            echo '{"error":"x","reason":"wrong-password"}'; exit 2"#;
        let root = installed("restore-fails", restore);
        let tool = Tool::of(&root).unwrap();
        assert_eq!(
            tool.restore(&root.join("f"), "password1", 5).await,
            Err(Refusal::WrongPassword)
        );
        assert_eq!(read(&root, "pgdata/table"), "rows now");
        assert_eq!(read(&root, "secrets"), "KEY=now");
        assert!(!root.join("before-restore/5-0").exists());
    }

    #[test]
    fn an_older_bundle_has_no_backup_command() {
        let root = installed("no-command", "");
        fs::write(
            root.join("versions/1/server/rakazo-server/manifest.json"),
            r#"{"entrypoints":{"api":"api.js"}}"#,
        )
        .unwrap();
        assert!(Tool::of(&root).is_none());
    }
}
