//! Updating the installed server to the version this app expects, and going back when the new one
//! does not start. Files only, no processes: `stack.rs` runs the steps around these.
//!
//! The order is what makes a cut-off update safe:
//! 1. `begin`: with nothing running, the server's data (`pgdata`, `data`, `relay`, `secrets`) is
//!    copied as files to `before-update/<from>-<time>/`, recorded in the `update` journal first as
//!    being copied, then as copied.
//! 2. The new version is installed beside the old one and only then made `current`.
//! 3. The server starts on it (the migrations run); `finish` drops the journal once it is ready.
//!
//! A journal found at the next start means step 3 never finished: `recover` puts the copied data
//! back and the old version as `current` when the new one had been switched to; otherwise nothing
//! touched the data and the journal just goes. Migrations cannot be undone, so going back always
//! means the copy. Why a file copy and not a `pg_dump`: the server is stopped, so the files are
//! consistent; going back is a rename; it needs no running Postgres of either version; and the
//! secrets and the relay keys come back with the database they belong to.

use std::cmp::Ordering;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use std::sync::Mutex;

use crate::stack_setup::write_private;

/// One update step at a time in this process: a stopped start cannot cancel a copy already under
/// way on its thread, so the next start's `recover` waits for it instead of racing it.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn turn() -> std::sync::MutexGuard<'static, ()> {
    ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Records `version` as the one to start, whole or not at all: a full disk never leaves it empty.
pub fn set_current(root: &Path, version: &str) -> io::Result<()> {
    write_private(&root.join("current"), version.as_bytes())
}

/// What a server's data is, as copied before an update.
const DATA: [&str; 4] = ["pgdata", "data", "relay", "secrets"];
/// How many copies are kept.
const KEEP: usize = 2;
const JOURNAL: &str = "update";
const SNAPSHOTS: &str = "before-update";
/// A version that failed to start after an update is not tried again on its own.
const SKIP: &str = "update-skip";

/// Compares bundle versions: upstream's `1.2.3` and the fork's revision after a dash (`1.2.3-2`;
/// none is 0). `None` when either is not of that form, which never updates.
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    Some(parse(a)?.cmp(&parse(b)?))
}

fn parse(version: &str) -> Option<(Vec<u64>, u64)> {
    let (base, revision) = version.split_once('-').unwrap_or((version, "0"));
    let base = base
        .split('.')
        .map(|part| part.parse().ok())
        .collect::<Option<Vec<u64>>>()?;
    Some((base, revision.parse().ok()?))
}

/// The update under way, as the journal records it.
#[derive(Clone, Debug, PartialEq)]
pub struct Journal {
    pub from: String,
    pub to: String,
    pub snapshot: PathBuf,
    /// The copy is complete.
    pub copied: bool,
}

pub fn journal(root: &Path) -> Option<Journal> {
    let text = fs::read_to_string(root.join(JOURNAL)).ok()?;
    let get = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .map(str::to_owned)
    };
    Some(Journal {
        from: get("from")?,
        to: get("to")?,
        snapshot: root.join(SNAPSHOTS).join(get("snapshot")?),
        copied: get("copied")? == "true",
    })
}

fn write_journal(root: &Path, journal: &Journal) -> io::Result<()> {
    let name = journal.snapshot.file_name().unwrap_or_default();
    let text = format!(
        "from={}\nto={}\nsnapshot={}\ncopied={}\n",
        journal.from,
        journal.to,
        name.to_string_lossy(),
        journal.copied
    );
    write_private(&root.join(JOURNAL), text.as_bytes())
}

/// Copies the data before an update from `from` to `to`. On an error (a full disk) the partial
/// copy and the journal are gone again and the error says why; nothing else changed.
pub fn begin(root: &Path, from: &str, to: &str, stamp: u64) -> io::Result<Journal> {
    let _turn = turn();
    // Room for this copy: the oldest go first, so copies never pile up past `KEEP`, even when
    // updates keep being cut off.
    prune_copies(root, KEEP - 1)?;
    // A name of its own, even for a second try within the same second.
    let snapshot = (0..)
        .map(|n| match n {
            0 => root.join(SNAPSHOTS).join(format!("{from}-{stamp}")),
            n => root.join(SNAPSHOTS).join(format!("{from}-{stamp}-{n}")),
        })
        .find(|path| fs::symlink_metadata(path).is_err())
        .expect("a free name");
    let mut journal = Journal {
        from: from.to_owned(),
        to: to.to_owned(),
        snapshot,
        copied: false,
    };
    write_journal(root, &journal)?;
    let copied = (|| {
        private_dir(&root.join(SNAPSHOTS))?;
        private_dir(&journal.snapshot)?;
        for name in DATA {
            let source = root.join(name);
            if fs::symlink_metadata(&source).is_ok() {
                copy_tree(&source, &journal.snapshot.join(name))?;
            }
        }
        journal.copied = true;
        write_journal(root, &journal)
    })();
    if let Err(error) = copied {
        let _ = fs::remove_dir_all(&journal.snapshot);
        let _ = fs::remove_file(root.join(JOURNAL));
        return Err(error);
    }
    Ok(journal)
}

/// What `recover` did with an update a start found unfinished.
#[derive(Debug, PartialEq)]
pub enum Recovered {
    /// No update was under way.
    Nothing,
    /// One was, but the data had not been used by the new version: only the journal went.
    Dropped,
    /// The new version had been made current: the data copy and the old version are back.
    RolledBack { from: String, to: String },
}

/// Brings the folder back to a consistent state after an update that did not finish, whatever
/// cut it off. Run with nothing running, before anything starts. Safe to run again after a cut.
pub fn recover(root: &Path) -> io::Result<Recovered> {
    let _turn = turn();
    let Some(journal) = journal(root) else {
        return Ok(Recovered::Nothing);
    };
    let current = fs::read_to_string(root.join("current")).unwrap_or_default();
    if !journal.copied {
        let _ = fs::remove_dir_all(&journal.snapshot);
    } else if current.trim() != journal.from {
        put_back(root, &journal)?;
        set_current(root, &journal.from)?;
        fs::remove_file(root.join(JOURNAL))?;
        return Ok(Recovered::RolledBack {
            from: journal.from,
            to: journal.to,
        });
    }
    fs::remove_file(root.join(JOURNAL))?;
    Ok(Recovered::Dropped)
}

/// The data from the copy, each in place with one rename; what the new version made that the
/// copy does not have goes.
fn put_back(root: &Path, journal: &Journal) -> io::Result<()> {
    for name in DATA {
        let target = root.join(name);
        let restore = root.join(format!("{name}.restore"));
        let old = root.join(format!("{name}.old"));
        remove(&restore)?;
        remove(&old)?;
        let copy = journal.snapshot.join(name);
        if fs::symlink_metadata(&copy).is_ok() {
            copy_tree(&copy, &restore)?;
        }
        if fs::symlink_metadata(&target).is_ok() {
            fs::rename(&target, &old)?;
        }
        if fs::symlink_metadata(&restore).is_ok() {
            fs::rename(&restore, &target)?;
        }
        remove(&old)?;
    }
    Ok(())
}

/// The update worked: the journal goes, and of the copies and the versions only the newest are
/// kept (the copies `KEEP`, the versions the current one and the one it replaced).
/// The journal must go before the server counts as updated: one left behind would make the next
/// start undo everything done since. So an error here is the start's error.
pub fn finish(root: &Path) -> io::Result<()> {
    let _turn = turn();
    let Some(journal) = journal(root) else {
        return Ok(());
    };
    fs::remove_file(root.join(JOURNAL))?;
    prune_copies(root, KEEP)?;
    for entry in fs::read_dir(root.join("versions"))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != journal.to && name != journal.from {
            remove(&entry.path())?;
        }
    }
    Ok(())
}

/// Keeps the newest `keep` copies.
fn prune_copies(root: &Path, keep: usize) -> io::Result<()> {
    let Ok(entries) = fs::read_dir(root.join(SNAPSHOTS)) else {
        return Ok(());
    };
    let mut copies: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    copies.sort_by_key(|path| fs::metadata(path).and_then(|meta| meta.modified()).ok());
    for old in copies.iter().rev().skip(keep) {
        remove(old)?;
    }
    Ok(())
}

/// The version that was put back after it failed to start, so it is not tried again until the
/// app expects a newer one.
pub fn skipped(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join(SKIP)).ok()?;
    Some(text.trim().to_owned()).filter(|version| !version.is_empty())
}

pub fn skip(root: &Path, version: &str) -> io::Result<()> {
    fs::write(root.join(SKIP), version)
}

fn remove(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// A copy of a file or folder, modes and links as they are (Postgres refuses a data folder that
/// others can read).
fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(source)?;
    if meta.file_type().is_symlink() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(fs::read_link(source)?, target)?;
        return Ok(());
    }
    if meta.is_file() {
        fs::copy(source, target)?;
        return Ok(());
    }
    if !meta.is_dir() {
        // A socket or a pipe: nothing to copy.
        return Ok(());
    }
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        copy_tree(&entry.path(), &target.join(entry.file_name()))?;
    }
    fs::set_permissions(target, meta.permissions())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stack_fetch::tests::scratch;

    /// A server folder on version `1` with data in it.
    fn installed(name: &str) -> PathBuf {
        let root = scratch(name);
        for version in ["0", "1"] {
            fs::create_dir_all(root.join("versions").join(version)).unwrap();
        }
        fs::write(root.join("current"), "1").unwrap();
        fs::create_dir_all(root.join("pgdata/base")).unwrap();
        fs::write(root.join("pgdata/base/table"), "old rows").unwrap();
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("data/file"), "a file").unwrap();
        fs::write(root.join("secrets"), "KEY=old").unwrap();
        root
    }

    /// What the new version's start does to the data.
    fn migrate(root: &Path) {
        fs::write(root.join("pgdata/base/table"), "migrated rows").unwrap();
        fs::create_dir_all(root.join("relay")).unwrap();
        fs::write(root.join("relay/host-key.json"), "{}").unwrap();
        fs::write(root.join("secrets"), "KEY=old\nNEW=1").unwrap();
    }

    fn read(root: &Path, path: &str) -> String {
        fs::read_to_string(root.join(path)).unwrap_or_default()
    }

    #[test]
    fn versions_compare_by_number_then_revision() {
        assert_eq!(compare("0.11.0-1", "0.11.0-2"), Some(Ordering::Less));
        assert_eq!(compare("0.11.0-2", "0.11.0-2"), Some(Ordering::Equal));
        assert_eq!(compare("0.12.0", "0.11.0-9"), Some(Ordering::Greater));
        assert_eq!(compare("0.11.0", "0.11.0-1"), Some(Ordering::Less));
        assert_eq!(compare("0.9.10", "0.10.0"), Some(Ordering::Less));
        assert_eq!(compare("next", "0.11.0"), None);
        assert_eq!(compare("0.11.0-x", "0.11.0"), None);
    }

    #[test]
    fn a_finished_update_keeps_the_new_data_and_the_last_two_copies() {
        let root = installed("update-ok");
        for (stamp, to) in [(1, "2"), (2, "3"), (3, "4")] {
            let from = read(&root, "current");
            let journal = begin(&root, &from, to, stamp).unwrap();
            assert!(journal.copied);
            fs::create_dir_all(root.join("versions").join(to)).unwrap();
            fs::write(root.join("current"), to).unwrap();
            migrate(&root);
            finish(&root).unwrap();
            // A different modification time for each copy.
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(journal(&root).is_none());
        assert_eq!(read(&root, "pgdata/base/table"), "migrated rows");
        assert_eq!(fs::read_dir(root.join(SNAPSHOTS)).unwrap().count(), 2);
        let mut versions: Vec<String> = fs::read_dir(root.join("versions"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        versions.sort();
        assert_eq!(versions, ["3", "4"]);
        assert_eq!(recover(&root).unwrap(), Recovered::Nothing);
    }

    #[test]
    fn a_new_version_that_started_and_failed_goes_back_to_the_copy() {
        let root = installed("update-back");
        begin(&root, "1", "2", 1).unwrap();
        fs::create_dir_all(root.join("versions/2")).unwrap();
        fs::write(root.join("current"), "2").unwrap();
        migrate(&root);
        assert_eq!(
            recover(&root).unwrap(),
            Recovered::RolledBack {
                from: "1".into(),
                to: "2".into()
            }
        );
        assert_eq!(read(&root, "current"), "1");
        assert_eq!(read(&root, "pgdata/base/table"), "old rows");
        assert_eq!(read(&root, "secrets"), "KEY=old");
        assert_eq!(read(&root, "data/file"), "a file");
        // The relay keys the new version made did not exist before.
        assert!(!root.join("relay").exists());
        assert!(journal(&root).is_none());
        // The copy stays, in case.
        assert!(fs::read_dir(root.join(SNAPSHOTS)).unwrap().count() == 1);
    }

    #[test]
    fn every_place_an_update_can_be_cut_ends_consistent() {
        // Cut while copying: the partial copy and the journal go, the data was never touched.
        let root = installed("cut-copying");
        let journal = begin(&root, "1", "2", 1).unwrap();
        write_journal(
            &root,
            &Journal {
                copied: false,
                ..journal.clone()
            },
        )
        .unwrap();
        assert_eq!(recover(&root).unwrap(), Recovered::Dropped);
        assert!(!journal.snapshot.exists());
        assert_eq!(read(&root, "current"), "1");

        // Cut after the copy, before the new version was made current: nothing to put back.
        let root = installed("cut-installing");
        begin(&root, "1", "2", 1).unwrap();
        fs::create_dir_all(root.join("versions/2.partial")).unwrap();
        assert_eq!(recover(&root).unwrap(), Recovered::Dropped);
        assert_eq!(read(&root, "pgdata/base/table"), "old rows");

        // Cut while going back, between two renames: running it again finishes it.
        let root = installed("cut-going-back");
        let journal = begin(&root, "1", "2", 1).unwrap();
        fs::write(root.join("current"), "2").unwrap();
        migrate(&root);
        fs::rename(root.join("pgdata"), root.join("pgdata.old")).unwrap();
        copy_tree(
            &journal.snapshot.join("pgdata"),
            &root.join("pgdata.restore"),
        )
        .unwrap();
        assert!(matches!(
            recover(&root).unwrap(),
            Recovered::RolledBack { .. }
        ));
        assert_eq!(read(&root, "pgdata/base/table"), "old rows");
        assert!(!root.join("pgdata.old").exists() && !root.join("pgdata.restore").exists());
        assert_eq!(read(&root, "current"), "1");
    }

    #[cfg(unix)]
    #[test]
    fn a_copy_keeps_modes_and_fails_cleanly() {
        use std::os::unix::fs::PermissionsExt;
        let root = installed("update-modes");
        fs::set_permissions(root.join("pgdata"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(root.join("secrets"), fs::Permissions::from_mode(0o600)).unwrap();
        let begun = begin(&root, "1", "2", 1).unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&begun.snapshot.join("pgdata")), 0o700);
        assert_eq!(mode(&begun.snapshot.join("secrets")), 0o600);
        assert_eq!(mode(&begun.snapshot), 0o700);
        recover(&root).unwrap();
        // A copy that cannot be made (here: the folder it goes to is taken by a file) leaves
        // neither a copy nor a journal.
        let root = installed("update-no-room");
        fs::write(root.join(SNAPSHOTS), "a file").unwrap();
        assert!(begin(&root, "1", "2", 1).is_err());
        assert!(journal(&root).is_none());
        assert_eq!(read(&root, "current"), "1");
    }

    #[test]
    fn two_tries_in_one_second_get_two_copies() {
        let root = installed("same-second");
        let first = begin(&root, "1", "2", 7).unwrap();
        recover(&root).unwrap();
        let second = begin(&root, "1", "2", 7).unwrap();
        assert_ne!(first.snapshot, second.snapshot);
        assert!(second.copied);
    }

    #[test]
    fn copies_never_pile_up_even_when_updates_are_cut_off() {
        let root = installed("cut-again-and-again");
        for stamp in 0..5 {
            begin(&root, "1", "2", stamp).unwrap();
            fs::write(root.join("current"), "2").unwrap();
            recover(&root).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(fs::read_dir(root.join(SNAPSHOTS)).unwrap().count(), KEEP);
    }

    #[test]
    fn a_stray_copy_finishes_before_the_next_start_looks() {
        let root = installed("stray-copy");
        let held = turn();
        let copying = {
            let root = root.clone();
            std::thread::spawn(move || begin(&root, "1", "2", 1))
        };
        let looking = {
            let root = root.clone();
            std::thread::spawn(move || recover(&root))
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(held);
        let begun = copying.join().unwrap();
        let recovered = looking.join().unwrap().unwrap();
        // Whichever went first, the folder is consistent: no journal pointing at a copy that
        // is gone, and the data as it was.
        if let Some(journal) = journal(&root) {
            assert!(journal.copied && journal.snapshot.join("pgdata").is_dir());
        } else {
            assert!(begun.is_ok() || recovered == Recovered::Nothing);
        }
        assert_eq!(read(&root, "pgdata/base/table"), "old rows");
    }

    #[test]
    fn a_skipped_version_is_remembered() {
        let root = scratch("skip");
        assert_eq!(skipped(&root), None);
        skip(&root, "0.11.0-2").unwrap();
        assert_eq!(skipped(&root).as_deref(), Some("0.11.0-2"));
    }
}
