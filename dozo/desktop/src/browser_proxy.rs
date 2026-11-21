//! The only way out for the bots' browsers (`browser.rs`): an HTTP proxy on loopback that every
//! request of theirs goes through, top-level pages, frames, scripts' requests and web sockets
//! alike. It resolves each host itself, refuses one that names or resolves to this computer or its
//! network (`public_host`, `public_ip`), and connects to the address it checked, so a name that
//! changes its answer between the check and the connection (DNS rebinding) cannot slip through.
//! A refused or failed connection gets the same short answer, so a page cannot tell which ports
//! answer behind it.
//!
//! What it does not hide: anyone on this computer can use the proxy, which reaches only what they
//! can already reach; it refuses the same local destinations for them.

// Windows starts no browser yet, so nothing starts the proxy there.
#![cfg_attr(windows, allow(dead_code))]

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const MAX_HEAD: usize = 16 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REFUSED: &[u8] =
    b"HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n";

/// Which hosts on this computer and its network get through: none, except in tests, which serve
/// their pages on loopback (all of them, or only the ports named).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum Local {
    None,
    All,
    Ports(Vec<u16>),
}

impl Local {
    fn allows(&self, ip: IpAddr, port: u16) -> bool {
        match self {
            Local::None => false,
            Local::All => true,
            Local::Ports(ports) => ip.is_loopback() && ports.contains(&port),
        }
    }
}

/// A running proxy; it stops with this value.
pub struct Proxy {
    pub port: u16,
    accept: tokio::task::JoinHandle<()>,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

impl Proxy {
    /// Starts it on a free loopback port.
    pub async fn start(local: Local) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let accept = tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                tokio::spawn(serve(client, local.clone()));
            }
        });
        Ok(Self { port, accept })
    }
}

/// One client connection: a CONNECT tunnel, or one plain HTTP request sent on with
/// `connection: close`, so the next request (maybe for another host) comes on a new connection.
async fn serve(mut client: TcpStream, local: Local) {
    let Some((head, rest)) = read_head(&mut client).await else {
        return;
    };
    let text = String::from_utf8_lossy(&head).into_owned();
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    if method.eq_ignore_ascii_case("CONNECT") {
        let Some((host, port)) = split_host_port(target, 443) else {
            let _ = client.write_all(REFUSED).await;
            return;
        };
        let Some(mut server) = open(&host, port, &local).await else {
            let _ = client.write_all(REFUSED).await;
            return;
        };
        if client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .is_err()
            || server.write_all(&rest).await.is_err()
        {
            return;
        }
        let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
        return;
    }
    let Ok(url) = tauri::Url::parse(target) else {
        let _ = client.write_all(REFUSED).await;
        return;
    };
    let (Some(host), "http") = (url.host_str(), url.scheme()) else {
        let _ = client.write_all(REFUSED).await;
        return;
    };
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let Some(mut server) = open(&host, url.port().unwrap_or(80), &local).await else {
        let _ = client.write_all(REFUSED).await;
        return;
    };
    let path = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    };
    let mut sent = format!("{method} {path} {}\r\n", first.next().unwrap_or("HTTP/1.1"));
    for line in lines.filter(|line| !line.is_empty()) {
        let name = line
            .split(':')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if ![
            "connection",
            "proxy-connection",
            "proxy-authorization",
            "keep-alive",
        ]
        .contains(&name.as_str())
        {
            sent.push_str(line);
            sent.push_str("\r\n");
        }
    }
    sent.push_str("connection: close\r\n\r\n");
    if server.write_all(sent.as_bytes()).await.is_err() || server.write_all(&rest).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
}

/// The request head up to its blank line, and whatever came after it.
async fn read_head(client: &mut TcpStream) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = tokio::time::timeout(CONNECT_TIMEOUT, client.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            let rest = buffer.split_off(end + 4);
            return Some((buffer, rest));
        }
        if buffer.len() > MAX_HEAD {
            return None;
        }
    }
}

fn split_host_port(target: &str, default: u16) -> Option<(String, u16)> {
    let (host, port) = match target.rsplit_once(':') {
        Some((host, port)) if !port.contains(']') => (host, port.parse().ok()?),
        _ => (target, default),
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    (!host.is_empty()).then(|| (host.to_owned(), port))
}

/// Connects to `host` at an address it resolves to that is outside this computer and its network,
/// or to none.
async fn open(host: &str, port: u16, local: &Local) -> Option<TcpStream> {
    let addresses: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) if *local == Local::None && !public_host(host) => return None,
        Err(_) => tokio::net::lookup_host((host, port)).await.ok()?.collect(),
    };
    // Every answer must be public: a name with one private answer among public ones is a name
    // meant to reach in.
    let allowed = |at: &SocketAddr| public_ip(at.ip()) || local.allows(at.ip(), at.port());
    if addresses.is_empty() || !addresses.iter().all(allowed) {
        return None;
    }
    for at in addresses {
        if let Ok(Ok(stream)) = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(at)).await
        {
            return Some(stream);
        }
    }
    None
}

/// A host name that is not this computer's or a local network's: no `localhost`, no single label
/// (a router or a machine on the network), and none of the names local networks use.
pub fn public_host(host: &str) -> bool {
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    if let Ok(ip) = name.parse::<IpAddr>() {
        return public_ip(ip);
    }
    const LOCAL: &[&str] = &[
        ".localhost",
        ".local",
        ".internal",
        ".intranet",
        ".home.arpa",
        ".home",
        ".lan",
        ".corp",
        ".localdomain",
        ".private",
        ".box",
    ];
    name.contains('.') && name != "localhost" && !LOCAL.iter().any(|suffix| name.ends_with(suffix))
}

/// An address outside this computer and its network: no loopback, private, link-local, shared,
/// benchmark, reserved or documentation range, and no IPv6 form of one.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || a == 0
        || a >= 224
        || (a == 100 && (64..128).contains(&b))
        || (a == 198 && (18..20).contains(&b))
        || (a == 192 && b == 0 && c == 0))
}

fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let segments = ip.segments();
    let first = segments[0];
    // 64:ff9b::/96 carries an IPv4 address (NAT64); ::/96 is the old IPv4-compatible form.
    let embedded = Ipv4Addr::new(
        (segments[6] >> 8) as u8,
        segments[6] as u8,
        (segments[7] >> 8) as u8,
        segments[7] as u8,
    );
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] || segments[..6] == [0, 0, 0, 0, 0, 0] {
        return !ip.is_loopback() && !ip.is_unspecified() && public_v4(embedded);
    }
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || first & 0xfe00 == 0xfc00
        || first & 0xffc0 == 0xfe80
        || first & 0xffc0 == 0xfec0
        || (first == 0x2001 && segments[1] == 0x0db8))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_lets_through_only_hosts_outside_this_computer_and_its_network() {
        for host in [
            "localhost",
            "app.localhost",
            "router",
            "fritz.box",
            "nas.lan",
            "intranet.corp",
            "printer.local",
            "host.localdomain",
            "db.internal",
            "router.home.arpa",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "198.18.0.1",
            "240.0.0.1",
            "0.0.0.0",
            "192.0.2.1",
            "::1",
            "fe80::1",
            "fd00::1",
            "fec0::1",
            "::ffff:10.0.0.1",
            "64:ff9b::a00:1",
            "::a00:1",
            "2001:db8::1",
        ] {
            assert!(!public_host(host), "{host}");
        }
        for host in [
            "example.com",
            "93.184.215.14",
            "2606:4700::1111",
            "64:ff9b::5db8:d70e",
        ] {
            assert!(public_host(host), "{host}");
        }
    }

    async fn ask(proxy: &Proxy, request: &str) -> String {
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port))
            .await
            .unwrap();
        client.write_all(request.as_bytes()).await.unwrap();
        let mut answer = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut answer)).await;
        String::from_utf8_lossy(&answer).into_owned()
    }

    /// A server on loopback that answers with the request line it got.
    async fn echo() -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut request = vec![0u8; 4096];
                    let read = stream.read(&mut request).await.unwrap_or(0);
                    let text = String::from_utf8_lossy(&request[..read]).into_owned();
                    let body = text.replace("\r\n", "|");
                    let _ = stream
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        )
                        .await;
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn it_refuses_this_computer_and_its_network_however_asked() {
        let port = echo().await;
        let proxy = Proxy::start(Local::None).await.unwrap();
        for request in [
            format!("GET http://127.0.0.1:{port}/ HTTP/1.1\r\nhost: x\r\n\r\n"),
            format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n"),
            format!("GET http://localhost:{port}/ HTTP/1.1\r\n\r\n"),
            format!("CONNECT [::1]:{port} HTTP/1.1\r\n\r\n"),
            "GET ftp://example.com/ HTTP/1.1\r\n\r\n".to_owned(),
            "nonsense\r\n\r\n".to_owned(),
        ] {
            assert!(
                ask(&proxy, &request).await.starts_with("HTTP/1.1 502"),
                "{request}"
            );
        }
    }

    #[tokio::test]
    async fn it_passes_a_request_on_and_tunnels_a_connect() {
        let port = echo().await;
        let proxy = Proxy::start(Local::All).await.unwrap();
        let answer = ask(
            &proxy,
            &format!(
                "GET http://127.0.0.1:{port}/a?b=1 HTTP/1.1\r\nhost: 127.0.0.1\r\nproxy-connection: keep-alive\r\nx-kept: 1\r\n\r\n"
            ),
        )
        .await;
        assert!(answer.contains("GET /a?b=1 HTTP/1.1|"), "{answer}");
        assert!(
            answer.contains("x-kept: 1|") && answer.contains("connection: close|"),
            "{answer}"
        );
        assert!(!answer.contains("proxy-connection"), "{answer}");
        let tunnel = ask(
            &proxy,
            &format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\nGET /t HTTP/1.1\r\n\r\n"),
        )
        .await;
        assert!(
            tunnel.starts_with("HTTP/1.1 200 Connection Established"),
            "{tunnel}"
        );
        assert!(tunnel.contains("GET /t HTTP/1.1"), "{tunnel}");
    }

    #[tokio::test]
    async fn tests_may_open_only_the_loopback_ports_they_name() {
        let (open, closed) = (echo().await, echo().await);
        let proxy = Proxy::start(Local::Ports(vec![open])).await.unwrap();
        let ok = ask(
            &proxy,
            &format!("GET http://127.0.0.1:{open}/ HTTP/1.1\r\n\r\n"),
        )
        .await;
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        let refused = ask(
            &proxy,
            &format!("GET http://127.0.0.1:{closed}/ HTTP/1.1\r\n\r\n"),
        )
        .await;
        assert!(refused.starts_with("HTTP/1.1 502"), "{refused}");
    }
}
