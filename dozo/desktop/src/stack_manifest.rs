//! The server manifest (`dozo/server-bundle/README.md`, "Manifest"): for each platform, the server
//! bundle, Node and Postgres, each with its address, sha256 and size. Pure logic, tested below.

use serde_json::Value;

/// One download: where it is, and what it must be.
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// What this computer installs: the server version and its three downloads.
#[derive(Clone, Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub server: Part,
    pub node: Part,
    pub postgres: Part,
}

/// This computer's name in the manifest, if a bundle is built for it.
pub fn platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("windows", "x86_64") => Some("win-x64"),
        _ => None,
    }
}

/// Reads the manifest for one platform. Every value is checked here, because the version becomes
/// a folder name and the rest decides what is downloaded and trusted.
pub fn parse(text: &str, platform: &str) -> Result<Release, String> {
    let manifest: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    if manifest.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err("unknown manifest schema".into());
    }
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| safe_name(version))
        .ok_or("bad version")?
        .to_owned();
    let parts = manifest
        .get("platforms")
        .and_then(|platforms| platforms.get(platform))
        .ok_or_else(|| format!("no bundle for {platform}"))?;
    let part = |name: &str| {
        parts
            .get(name)
            .and_then(read_part)
            .ok_or_else(|| format!("bad or missing {name}"))
    };
    Ok(Release {
        version,
        server: part("server")?,
        node: part("node")?,
        postgres: part("postgres")?,
    })
}

fn read_part(value: &Value) -> Option<Part> {
    let url = value.get("url")?.as_str()?;
    let sha256 = value.get("sha256")?.as_str()?;
    let size = value.get("size")?.as_u64()?;
    let scheme_ok = ["https://", "http://", "file://"]
        .iter()
        .any(|scheme| url.starts_with(scheme));
    let sha_ok = sha256.len() == 64
        && sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    (scheme_ok && sha_ok && size > 0).then(|| Part {
        url: url.to_owned(),
        sha256: sha256.to_owned(),
        size,
    })
}

/// A name that is safe as one folder: letters, digits, `.`, `_` and `-`, not starting with a dot.
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008";

    fn manifest(version: &str, server_sha: &str, url: &str) -> String {
        let part =
            |url: &str, sha: &str| format!(r#"{{"url":"{url}","sha256":"{sha}","size":10}}"#);
        format!(
            r#"{{"schema":1,"version":"{version}","platforms":{{"linux-x64":{{
              "server":{},"node":{},"postgres":{}}}}}}}"#,
            part(url, server_sha),
            part("https://nodejs.org/node.tar.xz", SHA),
            part("https://example.com/pg.tar.gz", SHA),
        )
    }

    #[test]
    fn reads_the_three_parts_of_a_platform() {
        let release = parse(
            &manifest("0.11.0", SHA, "file:///dist/server.tar.xz"),
            "linux-x64",
        )
        .unwrap();
        assert_eq!(release.version, "0.11.0");
        assert_eq!(release.server.url, "file:///dist/server.tar.xz");
        assert_eq!(release.node.size, 10);
        assert_eq!(release.postgres.sha256, SHA);
    }

    #[test]
    fn a_missing_platform_is_named() {
        let text = manifest("0.11.0", SHA, "https://x/s.tar.xz");
        assert_eq!(
            parse(&text, "win-x64").unwrap_err(),
            "no bundle for win-x64"
        );
    }

    #[test]
    fn refuses_values_it_cannot_trust() {
        let url = "https://x/s.tar.xz";
        // A version that would leave the versions folder.
        for version in ["../up", ".hidden", "a/b", ""] {
            assert!(parse(&manifest(version, SHA, url), "linux-x64").is_err());
        }
        // A sha256 that is not 64 lowercase hex digits.
        for sha in ["abc", &SHA.to_uppercase(), &format!("{}g", &SHA[1..])] {
            assert!(parse(&manifest("1", sha, url), "linux-x64").is_err());
        }
        // A scheme the app does not download from.
        assert!(parse(&manifest("1", SHA, "ftp://x/s"), "linux-x64").is_err());
        assert!(parse(&manifest("1", SHA, "/dist/s"), "linux-x64").is_err());
        // Another schema, or not JSON at all.
        let other = manifest("1", SHA, url).replace(r#""schema":1"#, r#""schema":2"#);
        assert!(parse(&other, "linux-x64").is_err());
        assert!(parse("not json", "linux-x64").is_err());
        // A size of zero.
        let empty = manifest("1", SHA, url).replacen(r#""size":10"#, r#""size":0"#, 1);
        assert!(parse(&empty, "linux-x64").is_err());
    }
}
