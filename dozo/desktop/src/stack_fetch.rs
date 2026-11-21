//! Downloads one part of the server and unpacks it. A download is written to `<sha256>.part`
//! beside its final name and goes on from where it stopped; it is trusted only once its size and
//! sha256 are the manifest's. An archive is unpacked into a folder beside the target and moved
//! into place in one rename, after every entry was checked to stay inside it. A bundle built on
//! Windows carries its links as a list (`LINKS`), made once it is in place. Tested below.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::stack_manifest::Part;

#[derive(Debug)]
pub enum FetchError {
    /// The download could not be made or finished; what has arrived is kept for the next try.
    Network(String),
    /// What arrived is not what the manifest names; it is deleted, so the next try starts clean.
    Damaged,
    Io(io::Error),
}

impl From<io::Error> for FetchError {
    fn from(error: io::Error) -> Self {
        FetchError::Io(error)
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Network(reason) => write!(f, "download failed: {reason}"),
            FetchError::Damaged => write!(f, "download does not match the manifest"),
            FetchError::Io(error) => write!(f, "{error}"),
        }
    }
}

/// Downloads `part` into `dir` and returns the verified file. `arrived` is told how many bytes
/// are on disk so far, including those kept from an earlier try.
pub async fn download(
    part: &Part,
    dir: &Path,
    arrived: &mut (dyn FnMut(u64) + Send),
) -> Result<PathBuf, FetchError> {
    fs::create_dir_all(dir)?;
    let done = dir.join(&part.sha256);
    if done.exists() {
        arrived(part.size);
        return Ok(done);
    }
    let partial = dir.join(format!("{}.part", part.sha256));
    // Written at its end, not opened to append: Windows refuses to cut an append-only file.
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&partial)?;
    let mut have = file.seek(SeekFrom::End(0))?;
    if have > part.size {
        start_over(&mut file)?;
        have = 0;
    }
    arrived(have);
    if have < part.size {
        if let Some(path) = local_path(&part.url) {
            copy_from(&path, &mut file, have, part.size, arrived)?;
        } else {
            fetch(&part.url, &mut file, have, part.size, arrived).await?;
        }
    }
    drop(file);
    let path = partial.clone();
    let sha = tokio::task::spawn_blocking(move || sha256_of(&path))
        .await
        .map_err(|error| FetchError::Io(io::Error::other(error)))??;
    if sha != part.sha256 || fs::metadata(&partial)?.len() != part.size {
        let _ = fs::remove_file(&partial);
        return Err(FetchError::Damaged);
    }
    fs::rename(&partial, &done)?;
    Ok(done)
}

/// The file a `file://` address names: `file:///C:/x` and `file://C:\\x` on Windows, `file:///x`
/// elsewhere.
pub fn local_path(url: &str) -> Option<PathBuf> {
    let path = url.strip_prefix("file://")?;
    let bytes = path.as_bytes();
    let drive =
        bytes.len() > 2 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':';
    Some(PathBuf::from(if cfg!(windows) && drive {
        &path[1..]
    } else {
        path
    }))
}

/// A local file (tests and development): the rest after what is already there.
fn copy_from(
    source: &Path,
    file: &mut File,
    have: u64,
    size: u64,
    arrived: &mut (dyn FnMut(u64) + Send),
) -> Result<(), FetchError> {
    let mut source = File::open(source)?;
    source.seek(SeekFrom::Start(have))?;
    let mut source = source.take(size - have);
    let mut buffer = vec![0; 1 << 16];
    let mut total = have;
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        file.write_all(&buffer[..read])?;
        total += read as u64;
        arrived(total);
    }
}

async fn fetch(
    url: &str,
    file: &mut File,
    have: u64,
    size: u64,
    arrived: &mut (dyn FnMut(u64) + Send),
) -> Result<(), FetchError> {
    let network = |error: reqwest::Error| FetchError::Network(error.to_string());
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(network)?;
    let mut request = client.get(url);
    if have > 0 {
        request = request.header("range", format!("bytes={have}-"));
    }
    let mut response = request.send().await.map_err(network)?;
    let mut total = match response.status().as_u16() {
        206 if have > 0 => have,
        // The server sent the whole file: start over.
        200 => {
            start_over(file)?;
            0
        }
        status => return Err(FetchError::Network(format!("HTTP {status}"))),
    };
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        total += chunk.len() as u64;
        if total > size {
            start_over(file)?;
            return Err(FetchError::Damaged);
        }
        file.write_all(&chunk)?;
        arrived(total);
    }
    if total < size {
        return Err(FetchError::Network("the connection ended early".into()));
    }
    Ok(())
}

fn start_over(file: &mut File) -> io::Result<()> {
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0)).map(drop)
}

fn sha256_of(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 16];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// The archive formats the manifest uses: Node for Windows is a zip.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Format {
    TarXz,
    TarGz,
    Zip,
}

impl Format {
    /// From the end of the download's address.
    pub fn of(url: &str) -> Option<Format> {
        if url.ends_with(".tar.xz") {
            Some(Format::TarXz)
        } else if url.ends_with(".tar.gz") || url.ends_with(".tgz") {
            Some(Format::TarGz)
        } else if url.ends_with(".zip") {
            Some(Format::Zip)
        } else {
            None
        }
    }
}

/// Unpacks `archive` to `target`, which must not exist yet. With `strip_top`, the archive holds
/// one top folder and its content becomes `target`. Nothing is at `target` unless it all worked.
pub fn unpack(archive: &Path, format: Format, target: &Path, strip_top: bool) -> io::Result<()> {
    let mut scratch = target.as_os_str().to_owned();
    scratch.push(".unpack");
    let scratch = PathBuf::from(scratch);
    if scratch.exists() {
        fs::remove_dir_all(&scratch)?;
    }
    fs::create_dir_all(&scratch)?;
    let file = io::BufReader::new(File::open(archive)?);
    let unpacked = match format {
        Format::TarXz => unpack_checked(
            Box::new(xz2::read::XzDecoder::new_multi_decoder(file)),
            &scratch,
        ),
        Format::TarGz => {
            unpack_checked(Box::new(flate2::read::MultiGzDecoder::new(file)), &scratch)
        }
        Format::Zip => unpack_zip(file, &scratch),
    };
    let result = unpacked.and_then(|()| {
        let source = if strip_top {
            only_folder(&scratch)?
        } else {
            scratch.clone()
        };
        fs::rename(source, target)
    });
    let _ = fs::remove_dir_all(&scratch);
    result
}

fn unpack_checked(reader: Box<dyn Read>, into: &Path) -> io::Result<()> {
    let mut archive = tar::Archive::new(reader);
    archive.set_preserve_permissions(true);
    archive.set_unpack_xattrs(false);
    archive.set_overwrite(false);
    let mut links = HashSet::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let link = entry.link_name()?.map(|link| link.into_owned());
        let kind = entry.header().entry_type();
        check_entry(&path, kind, link.as_deref(), &links)?;
        if !entry.unpack_in(into)? {
            return Err(refused(&path));
        }
        if kind == tar::EntryType::Symlink {
            links.insert(inside(Path::new(""), &path).unwrap_or_default());
        }
    }
    Ok(())
}

/// A zip's files and folders, each checked to stay inside; links and anything else are refused.
fn unpack_zip(file: io::BufReader<File>, into: &Path) -> io::Result<()> {
    let mut archive = zip::ZipArchive::new(file).map_err(io::Error::other)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(io::Error::other)?;
        let name = PathBuf::from(entry.name().map_err(io::Error::other)?.into_owned());
        let path = inside(Path::new(""), &name)
            .filter(|_| !entry.is_symlink())
            .ok_or_else(|| refused(&name))?;
        let at = into.join(&path);
        if entry.is_dir() {
            fs::create_dir_all(&at)?;
            continue;
        }
        if let Some(parent) = at.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = OpenOptions::new().write(true).create_new(true).open(&at)?;
        io::copy(&mut entry, &mut out)?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            out.set_permissions(fs::Permissions::from_mode(mode & 0o755))?;
        }
    }
    Ok(())
}

/// The list of links a bundle built on Windows carries instead of links (pnpm makes junctions
/// there, which an archive cannot hold): `{ "<link>": "<target>" }`, the link from the bundle's
/// top and the target from the link's folder, both with forward slashes.
pub const LINKS: &str = "dozo-links.json";

/// Makes the links `LINKS` lists in the folder `root`, if it has one: each checked as an archive's
/// link is (inside `root`, by name), and made as a symbolic link, or on Windows, where that needs
/// a privilege, as a junction to a folder or a copy of a file. Returns how many it made.
pub fn make_links(root: &Path) -> io::Result<usize> {
    let text = match fs::read_to_string(root.join(LINKS)) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let list: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&text).map_err(io::Error::other)?;
    let mut made = 0;
    for (link, target) in &list {
        let target = target.as_str().ok_or_else(|| refused(Path::new(link)))?;
        let (at, to) = link_paths(root, link, target)?;
        if let Some(parent) = at.parent() {
            fs::create_dir_all(parent)?;
        }
        crate::stack_os::make_link(&at, &to, Path::new(target))?;
        made += 1;
    }
    Ok(made)
}

/// Where a listed link goes and what it points at, both under `root`; refused unless both stay
/// inside it by name and the target's `..` only lead it, as for an archive's link.
fn link_paths(root: &Path, link: &str, target: &str) -> io::Result<(PathBuf, PathBuf)> {
    // Plain names between single slashes: no root, drive or backslash.
    let parts = |text: &str| -> Option<PathBuf> {
        text.split('/')
            .map(|part| (!part.is_empty() && !part.contains(['\\', ':'])).then_some(part))
            .collect()
    };
    let (Some(link_path), Some(target_path)) = (parts(link), parts(target)) else {
        return Err(refused(Path::new(link)));
    };
    let clean = inside(Path::new(""), &link_path)
        .filter(|clean| clean.components().count() == link_path.components().count())
        .filter(|clean| !clean.as_os_str().is_empty())
        .ok_or_else(|| refused(&link_path))?;
    let from = clean.parent().unwrap_or(Path::new(""));
    let to = Some(&target_path)
        .filter(|target| leading_dots_only(target))
        .and_then(|target| inside(from, target))
        .ok_or_else(|| refused(&link_path))?;
    Ok((root.join(clean), root.join(to)))
}

/// Every entry stays inside the folder it is unpacked into: no absolute path, no `..`, nothing
/// placed under a link the archive made (`links`), and a link may point only at something inside.
/// A link's `..` may only lead its target, so where it points is what its name says, whatever the
/// links it passes through. Devices and pipes are refused.
pub fn check_entry(
    path: &Path,
    kind: tar::EntryType,
    link: Option<&Path>,
    links: &HashSet<PathBuf>,
) -> io::Result<()> {
    let Some(clean) = inside(Path::new(""), path) else {
        return Err(refused(path));
    };
    if clean
        .ancestors()
        .skip(1)
        .any(|folder| links.contains(folder))
    {
        return Err(refused(path));
    }
    match kind {
        tar::EntryType::Regular
        | tar::EntryType::Continuous
        | tar::EntryType::Directory
        | tar::EntryType::GNUSparse => Ok(()),
        tar::EntryType::Symlink => {
            // Relative to the link's own folder.
            let from = clean.parent().unwrap_or(Path::new(""));
            match link {
                Some(target) if leading_dots_only(target) && inside(from, target).is_some() => {
                    Ok(())
                }
                _ => Err(refused(path)),
            }
        }
        // A hard link names another entry of the archive, from its top.
        tar::EntryType::Link => match link {
            Some(target) if inside(Path::new(""), target).is_some() => Ok(()),
            _ => Err(refused(path)),
        },
        _ => Err(refused(path)),
    }
}

fn leading_dots_only(target: &Path) -> bool {
    let mut named = false;
    target.components().all(|part| match part {
        Component::ParentDir => !named,
        Component::Normal(_) => {
            named = true;
            true
        }
        Component::CurDir => true,
        Component::RootDir | Component::Prefix(_) => false,
    })
}

/// `base` joined with `relative`, resolved by name, if it stays inside the top (an empty result
/// is the top itself).
fn inside(base: &Path, relative: &Path) -> Option<PathBuf> {
    let mut resolved: Vec<Component> = base.components().collect();
    for part in relative.components() {
        match part {
            Component::Normal(_) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop()?;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(resolved.iter().collect())
}

fn only_folder(scratch: &Path) -> io::Result<PathBuf> {
    let mut entries = fs::read_dir(scratch)?.collect::<Result<Vec<_>, _>>()?;
    match (entries.pop(), entries.is_empty()) {
        (Some(only), true) if only.file_type()?.is_dir() => Ok(only.path()),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the archive does not hold one top folder",
        )),
    }
}

fn refused(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("refused archive entry {}", path.display()),
    )
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::BufRead;
    use std::net::TcpListener;

    pub fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dozo-stack-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn part_for(bytes: &[u8], url: String) -> Part {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        Part {
            url,
            sha256: hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            size: bytes.len() as u64,
        }
    }

    fn body() -> Vec<u8> {
        (0..200_000u32).flat_map(|n| n.to_le_bytes()).collect()
    }

    /// A one-request-at-a-time HTTP server for `body`, honouring `Range: bytes=N-` unless told
    /// to ignore it. Returns its address and the ranges it was asked for.
    fn serve(body: Vec<u8>, honour_range: bool) -> (String, std::sync::mpsc::Receiver<u64>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/file.tar.xz", listener.local_addr().unwrap());
        let (asked, ranges) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = io::BufReader::new(stream.try_clone().unwrap());
                let mut from = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                    if let Some(range) = line.to_lowercase().strip_prefix("range: bytes=") {
                        from = range.trim().trim_end_matches('-').parse().unwrap();
                    }
                }
                let _ = asked.send(from);
                let (status, start) = if from > 0 && honour_range {
                    ("206 Partial Content", from as usize)
                } else {
                    ("200 OK", 0)
                };
                let rest = &body[start..];
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    rest.len()
                );
                let _ = stream.write_all(rest);
            }
        });
        (address, ranges)
    }

    #[tokio::test]
    async fn a_half_download_goes_on_from_where_it_stopped() {
        let dir = scratch("resume");
        let body = body();
        let (url, ranges) = serve(body.clone(), true);
        let part = part_for(&body, url);
        fs::write(dir.join(format!("{}.part", part.sha256)), &body[..300_000]).unwrap();
        let mut seen = Vec::new();
        let file = download(&part, &dir, &mut |n| seen.push(n)).await.unwrap();
        assert_eq!(ranges.recv().unwrap(), 300_000);
        assert_eq!(fs::read(&file).unwrap(), body);
        assert_eq!(seen.first(), Some(&300_000));
        assert_eq!(seen.last(), Some(&(body.len() as u64)));
        assert!(!dir.join(format!("{}.part", part.sha256)).exists());
    }

    #[tokio::test]
    async fn a_server_that_ignores_the_range_starts_it_over_cleanly() {
        let dir = scratch("fetch-restart");
        let body = body();
        let (url, ranges) = serve(body.clone(), false);
        let part = part_for(&body, url);
        fs::write(dir.join(format!("{}.part", part.sha256)), &body[..1000]).unwrap();
        let file = download(&part, &dir, &mut |_| {}).await.unwrap();
        assert_eq!(ranges.recv().unwrap(), 1000);
        assert_eq!(fs::read(&file).unwrap(), body);
    }

    #[tokio::test]
    async fn a_download_whose_sha256_differs_is_refused_and_deleted() {
        let dir = scratch("sha");
        let body = body();
        let (url, _) = serve(body.clone(), true);
        let mut part = part_for(&body, url);
        part.sha256 = "0".repeat(64);
        let result = download(&part, &dir, &mut |_| {}).await;
        assert!(matches!(result, Err(FetchError::Damaged)));
        assert!(!dir.join(&part.sha256).exists());
        assert!(!dir.join(format!("{}.part", part.sha256)).exists());
    }

    #[tokio::test]
    async fn a_local_file_is_copied_and_checked_too() {
        let dir = scratch("file");
        let source = dir.join("source");
        let body = body();
        fs::write(&source, &body).unwrap();
        let part = part_for(&body, format!("file://{}", source.display()));
        let file = download(&part, &dir.join("downloads"), &mut |_| {})
            .await
            .unwrap();
        assert_eq!(fs::read(file).unwrap(), body);
        // More bytes than the manifest says: refused.
        let mut short = part.clone();
        short.size -= 1;
        short.sha256 = "1".repeat(64);
        let result = download(&short, &dir.join("other"), &mut |_| {}).await;
        assert!(matches!(result, Err(FetchError::Damaged)));
    }

    fn tar_gz(build: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        build(&mut builder);
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }

    fn file_entry(builder: &mut tar::Builder<Vec<u8>>, path: &str, body: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_entry_type(tar::EntryType::Regular);
        // Written straight into the header, so a path the builder would refuse still gets in.
        header.as_gnu_mut().unwrap().name[..path.len()].copy_from_slice(path.as_bytes());
        header.set_cksum();
        builder.append(&header, body).unwrap();
    }

    fn link_entry(builder: &mut tar::Builder<Vec<u8>>, path: &str, target: &str) {
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_path(path).unwrap();
        header.set_link_name(target).unwrap();
        header.set_cksum();
        builder.append(&header, &[][..]).unwrap();
    }

    // Windows makes a symbolic link only with a privilege a test run may not have.
    #[cfg(unix)]
    #[test]
    fn unpacks_one_top_folder_into_place() {
        let dir = scratch("unpack");
        let archive = dir.join("a.tar.gz");
        fs::write(
            &archive,
            tar_gz(|b| {
                file_entry(b, "node-v1/bin/node", b"#!");
                link_entry(b, "node-v1/bin/npm", "../lib/npm.js");
                file_entry(b, "node-v1/lib/npm.js", b"js");
            }),
        )
        .unwrap();
        let target = dir.join("node");
        unpack(&archive, Format::TarGz, &target, true).unwrap();
        assert_eq!(fs::read(target.join("bin/node")).unwrap(), b"#!");
        assert_eq!(fs::read(target.join("bin/npm")).unwrap(), b"js");
        assert!(!dir.join("node.unpack").exists());
    }

    #[test]
    fn an_archive_that_escapes_its_folder_is_refused_whole() {
        let dir = scratch("slip");
        for (name, archive) in [
            ("dotdot", tar_gz(|b| file_entry(b, "top/../../evil", b"x"))),
            ("absolute", tar_gz(|b| file_entry(b, "/tmp/evil", b"x"))),
            ("link", tar_gz(|b| link_entry(b, "top/out", "../../etc"))),
            (
                "abslink",
                tar_gz(|b| link_entry(b, "top/out", "/etc/passwd")),
            ),
            // Each target stays inside by name, but `b` is the top itself, so `b/..` is its
            // parent on disk.
            (
                "chain",
                tar_gz(|b| {
                    link_entry(b, "a/b", "..");
                    link_entry(b, "a/c", "b/..");
                }),
            ),
            // A file placed through a link the archive made.
            (
                "through",
                tar_gz(|b| {
                    link_entry(b, "a/b", "..");
                    file_entry(b, "a/b/x", b"x");
                }),
            ),
        ] {
            let path = dir.join(format!("{name}.tar.gz"));
            fs::write(&path, archive).unwrap();
            let target = dir.join(name);
            let error = unpack(&path, Format::TarGz, &target, false).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{name}");
            assert!(!target.exists(), "{name}");
            assert!(!dir.join(format!("{name}.unpack")).exists(), "{name}");
        }
        assert!(!dir.parent().unwrap().join("evil").exists());
    }

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in entries {
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(body).unwrap();
            }
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn a_zip_unpacks_one_top_folder_into_place_and_one_that_escapes_is_refused() {
        let dir = scratch("zip");
        let archive = dir.join("node.zip");
        fs::write(
            &archive,
            zip_of(&[
                ("node-v1/", b""),
                ("node-v1/node.exe", b"MZ"),
                ("node-v1/node_modules/npm/index.js", b"js"),
            ]),
        )
        .unwrap();
        assert_eq!(
            Format::of("https://x/node-v1-win-x64.zip"),
            Some(Format::Zip)
        );
        let target = dir.join("node");
        unpack(&archive, Format::Zip, &target, true).unwrap();
        assert_eq!(fs::read(target.join("node.exe")).unwrap(), b"MZ");
        assert_eq!(
            fs::read(target.join("node_modules/npm/index.js")).unwrap(),
            b"js"
        );
        for (name, entry) in [("dotdot", "top/../../evil"), ("absolute", "/tmp/evil")] {
            let path = dir.join(format!("{name}.zip"));
            fs::write(&path, zip_of(&[(entry, b"x")])).unwrap();
            let target = dir.join(name);
            let error = unpack(&path, Format::Zip, &target, false).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{name}");
            assert!(!target.exists() && !dir.join(format!("{name}.unpack")).exists());
        }
        assert!(!dir.parent().unwrap().join("evil").exists());
    }

    #[test]
    fn a_file_address_names_its_file() {
        assert_eq!(local_path("https://x/y"), None);
        let path = local_path("file:///dist/manifest.json").unwrap();
        if cfg!(windows) {
            assert_eq!(path, PathBuf::from("/dist/manifest.json"));
            assert_eq!(
                local_path("file:///C:/dist/a.tar.xz").unwrap(),
                PathBuf::from("C:/dist/a.tar.xz")
            );
        } else {
            assert_eq!(path, PathBuf::from("/dist/manifest.json"));
        }
    }

    #[test]
    fn the_listed_links_are_made_inside_and_reach_their_targets() {
        let root = scratch("links");
        let package = root.join("node_modules/.pnpm/a@1/node_modules/a");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("index.js"), "a").unwrap();
        fs::write(package.join("LICENSE"), "l").unwrap();
        assert_eq!(make_links(&root).unwrap(), 0, "no list, nothing to make");
        fs::write(
            root.join(LINKS),
            r#"{
              "apps/api/node_modules/a": "../../../node_modules/.pnpm/a@1/node_modules/a",
              "node_modules/.pnpm/node_modules/a": "../a@1/node_modules/a",
              "node_modules/.pnpm/a@1/node_modules/a/COPYING": "LICENSE"
            }"#,
        )
        .unwrap();
        assert_eq!(make_links(&root).unwrap(), 3);
        for link in [
            "apps/api/node_modules/a",
            "node_modules/.pnpm/node_modules/a",
        ] {
            assert_eq!(
                fs::read_to_string(root.join(link).join("index.js")).unwrap(),
                "a"
            );
        }
        assert_eq!(fs::read_to_string(package.join("COPYING")).unwrap(), "l");
        for (link, target) in [
            ("a/b", "../../outside"),
            ("a/b", "/etc"),
            ("a/b", "c/../../.."),
            ("../b", "x"),
            ("a/../b", "x"),
            ("", "x"),
        ] {
            let other = scratch("links-refused");
            fs::write(
                other.join(LINKS),
                serde_json::json!({ link: target }).to_string(),
            )
            .unwrap();
            let error = make_links(&other).unwrap_err();
            assert_eq!(
                error.kind(),
                io::ErrorKind::InvalidData,
                "{link} -> {target}"
            );
        }
    }

    #[test]
    fn entry_checks() {
        use tar::EntryType::*;
        let p = Path::new;
        let none = HashSet::new();
        let check = |path, kind, link| check_entry(p(path), kind, link, &none);
        assert!(check("a/b", Regular, None).is_ok());
        assert!(check("./a/b", Directory, None).is_ok());
        assert!(check("a/b/c", Symlink, Some(p("../d"))).is_ok());
        assert!(check("a/b/c", Symlink, Some(p("../../e/f"))).is_ok());
        assert!(check("a/c", Symlink, Some(p("../../d"))).is_err());
        assert!(check("a/c", Symlink, Some(p("d/../e"))).is_err());
        assert!(check("a/c", Link, Some(p("a/b"))).is_ok());
        assert!(check("a/c", Link, Some(p("../b"))).is_err());
        assert!(check("a/dev", Char, None).is_err());
        assert!(check("a/fifo", Fifo, None).is_err());
        let links = HashSet::from([PathBuf::from("a/l")]);
        assert!(check_entry(p("a/l/x"), Regular, None, &links).is_err());
        assert!(check_entry(p("a/lx"), Regular, None, &links).is_ok());
    }
}
