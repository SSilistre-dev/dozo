//! The bot's own browser end to end, with the browser installed on this computer and a test page
//! served on loopback (part of `browser.rs`'s tests). `tests/stack_e2e_native.sh` runs these on
//! Linux and macOS; each is ignored in a plain test run, as it needs Chrome, Edge, Brave or
//! Chromium. `DOZO_BROWSER_E2E_WINDOW=1` opens a real window (Xvfb on Linux) instead of a headless
//! browser, and `DOZO_BROWSER_E2E_SHOT` names a file for a screenshot of the page.

use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;

const PAGE: &str = "<!doctype html><html><head><title>Dozo browser test</title></head><body>\
<label>Name <input id=\"name\"></label>\
<button onclick=\"document.getElementById('out').textContent='Hello, '+document.getElementById('name').value\">Greet</button>\
<p id=\"out\"></p>\
<button onclick=\"navigator.clipboard.writeText('x').then(()=>r('api-wrote'),()=>r('api-refused'))\">Copy API</button>\
<button onclick=\"document.addEventListener('copy',e=>{e.clipboardData.setData('text/plain','x');e.preventDefault()},{once:true});r(document.execCommand('copy')?'exec-wrote':'exec-refused')\">Copy command</button>\
<button onclick=\"document.documentElement.requestFullscreen().then(()=>r('screen-taken'),()=>r('screen-refused'))\">Full screen</button>\
<p id=\"probe\">probe:</p><script>function r(t){document.getElementById('probe').textContent+=' '+t}\
document.addEventListener('copy',()=>r('copied'));document.addEventListener('paste',()=>r('pasted'));document.addEventListener('cut',()=>r('snipped'));</script>\
</body></html>";

/// Serves `PAGE` to every request on loopback, from a thread, and returns its address.
fn serve() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}/", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nset-cookie: secret=kept-here\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{PAGE}",
                PAGE.len()
            );
        }
    });
    address
}

fn browsers(root: &Path) -> Browsers {
    let program = find().expect("a Chromium-family browser on this computer");
    println!("E2E: browser {}", program.display());
    let window = std::env::var_os("DOZO_BROWSER_E2E_WINDOW").is_some();
    Browsers::with(root.join("browser-profiles"), Some(program), !window).with_local_pages()
}

/// The bot's running browser and page session, to do what the person could do in its window.
fn person(browsers: &Browsers) -> (Arc<Running>, String) {
    let running = browsers.open.lock().unwrap().get("bot").cloned().unwrap();
    let session = running.pipe.session.lock().unwrap().clone().unwrap();
    (running, session)
}

/// `DOZO_BROWSER_E2E_ROOT` when given (kept, so a later test finds what an earlier left), else a
/// fresh folder.
fn root() -> PathBuf {
    if let Some(root) = std::env::var_os("DOZO_BROWSER_E2E_ROOT") {
        return PathBuf::from(root);
    }
    let root = std::env::temp_dir().join(format!("dozo-browser-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    root
}

async fn call(browsers: &Browsers, method: &str, params: Value) -> Value {
    let command = json!({ "method": method, "params": params });
    match browsers.handle("bot", &command).await {
        Ok(answer) => answer["result"].clone(),
        Err(error) => panic!("{method}: {error}"),
    }
}

/// The page's accessibility nodes that are not ignored, as (role, name, backend node id).
async fn nodes(browsers: &Browsers) -> Vec<(String, String, u64)> {
    let tree = call(browsers, "Accessibility.getFullAXTree", json!({})).await;
    tree["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|node| node["ignored"] != true)
        .map(|node| {
            (
                node["role"]["value"].as_str().unwrap_or("").to_owned(),
                node["name"]["value"].as_str().unwrap_or("").to_owned(),
                node["backendDOMNodeId"].as_u64().unwrap_or(0),
            )
        })
        .collect()
}

async fn wait_for(browsers: &Browsers, name: &str) -> Vec<(String, String, u64)> {
    for _ in 0..100 {
        let found = nodes(browsers).await;
        if found.iter().any(|(_, text, _)| text.contains(name)) {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{name} never appeared on the page");
}

async fn click(browsers: &Browsers, node: u64) {
    let model = call(
        browsers,
        "DOM.getBoxModel",
        json!({ "backendNodeId": node }),
    )
    .await;
    let quad = model["model"]["content"].as_array().unwrap();
    let x = (quad[0].as_f64().unwrap() + quad[4].as_f64().unwrap()) / 2.0;
    let y = (quad[1].as_f64().unwrap() + quad[5].as_f64().unwrap()) / 2.0;
    for kind in ["mousePressed", "mouseReleased"] {
        let event = json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 });
        call(browsers, "Input.dispatchMouseEvent", event).await;
    }
}

fn find_node(found: &[(String, String, u64)], role: &str, name: &str) -> u64 {
    found
        .iter()
        .find(|(r, n, _)| r == role && n.contains(name))
        .unwrap_or_else(|| panic!("no {role} {name:?} in {found:?}"))
        .2
}

/// The pid of the bot's browser, from the file its start left.
fn browser_pid(root: &Path) -> u32 {
    let file = root.join("browser-profiles").join(format!("{}.pid", key()));
    std::fs::read_to_string(file)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

fn key() -> &'static str {
    "bot"
}

/// The TCP ports anything in the browser's process group listens on.
#[cfg(target_os = "linux")]
fn listening(group: u32) -> Vec<String> {
    let mut inodes = std::collections::HashSet::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        // The group is the fifth field, after the name in parentheses.
        let after = stat.rsplit_once(')').map(|(_, rest)| rest).unwrap_or("");
        if after.split_whitespace().nth(2) != Some(&group.to_string()) {
            continue;
        }
        for fd in std::fs::read_dir(format!("/proc/{pid}/fd"))
            .into_iter()
            .flatten()
            .flatten()
        {
            let link = std::fs::read_link(fd.path()).unwrap_or_default();
            let link = link.to_string_lossy();
            if let Some(inode) = link
                .strip_prefix("socket:[")
                .and_then(|s| s.strip_suffix(']'))
            {
                inodes.insert(inode.to_owned());
            }
        }
    }
    let mut ports = Vec::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        for line in std::fs::read_to_string(table)
            .unwrap_or_default()
            .lines()
            .skip(1)
        {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // State 0A is LISTEN; the inode is the tenth field.
            if fields.len() > 9 && fields[3] == "0A" && inodes.contains(fields[9]) {
                ports.push(fields[1].to_owned());
            }
        }
    }
    ports
}

#[cfg(target_os = "macos")]
fn listening(group: u32) -> Vec<String> {
    let out = std::process::Command::new("lsof")
        .args([
            "-nP",
            "-a",
            "-g",
            &group.to_string(),
            "-iTCP",
            "-sTCP:LISTEN",
        ])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .skip(1)
        .map(str::to_owned)
        .collect()
}

/// A real browser with a profile of its own and no debugging port: the page tools work through
/// the pipe, and what is not allowed is refused before it reaches the browser.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Chrome, Edge, Brave or Chromium; run by tests/stack_e2e_native.sh"]
async fn e2e_browser_page_tools_work_through_the_pipe_only() {
    let root = root();
    let browsers = browsers(&root);
    let page = serve();
    call(&browsers, "Page.navigate", json!({ "url": page })).await;
    let found = wait_for(&browsers, "Greet").await;
    click(&browsers, find_node(&found, "textbox", "Name")).await;
    call(&browsers, "Input.insertText", json!({ "text": "Ada" })).await;
    click(&browsers, find_node(&found, "button", "Greet")).await;
    wait_for(&browsers, "Hello, Ada").await;
    println!("E2E: navigated, typed and clicked through the pipe");

    // A click of the bot's counts as a gesture: the page still cannot write the clipboard or take
    // the screen with it.
    for button in ["Copy API", "Copy command", "Full screen"] {
        click(&browsers, find_node(&found, "button", button)).await;
    }
    let mut probe = String::new();
    for _ in 0..50 {
        let shown = nodes(&browsers).await;
        probe = shown
            .iter()
            .find(|(_, name, _)| name.starts_with("probe:"))
            .map(|(_, name, _)| name.clone())
            .unwrap_or_default();
        if probe.split(' ').count() == 4 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut outcomes: Vec<&str> = probe.split(' ').skip(1).collect();
    outcomes.sort_unstable();
    assert_eq!(
        outcomes,
        ["api-refused", "exec-refused", "screen-refused"],
        "{probe}"
    );
    println!("E2E: the page's clipboard writes and full screen refused after a bot's click");

    let events = browsers
        .handle("bot", &json!({ "method": "Page.getFrameTree" }))
        .await
        .unwrap();
    assert!(
        events["result"]["frameTree"]["frame"]["url"]
            .as_str()
            .unwrap()
            .starts_with(&page)
    );

    let shot = call(
        &browsers,
        "Page.captureScreenshot",
        json!({ "format": "png" }),
    )
    .await;
    let data = shot["data"].as_str().unwrap();
    assert!(data.len() > 1000, "a screenshot of the page");
    if let Some(path) = std::env::var_os("DOZO_BROWSER_E2E_SHOT") {
        let bytes = base64_decode(data);
        assert_eq!(&bytes[..4], b"\x89PNG");
        std::fs::write(&path, bytes).unwrap();
        println!("E2E: screenshot written");
    }

    for refused in [
        json!({ "method": "Runtime.evaluate", "params": { "expression": "document.cookie" } }),
        json!({ "method": "Network.getCookies" }),
        json!({ "method": "Storage.getCookies" }),
        json!({ "method": "Page.navigate", "params": { "url": "javascript:document.cookie" } }),
        json!({ "method": "Page.navigate", "params": { "url": "file:///etc/hosts" } }),
    ] {
        let error = browsers.handle("bot", &refused).await.unwrap_err();
        assert!(
            error.starts_with("Not allowed") || error.contains("only websites"),
            "{error}"
        );
    }
    println!("E2E: cookie, storage and script commands refused");

    // The keyboard's own Copy, Cut and Paste keys never reach the page.
    click(&browsers, find_node(&found, "textbox", "Name")).await;
    for key in ["Copy", "Cut", "Paste"] {
        for params in [
            json!({ "type": "keyDown", "key": key }),
            json!({ "type": "rawKeyDown", "code": key }),
        ] {
            let press = json!({ "method": "Input.dispatchKeyEvent", "params": params });
            assert!(
                browsers.handle("bot", &press).await.is_err(),
                "{key} passed"
            );
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let probe = nodes(&browsers)
        .await
        .into_iter()
        .find(|(_, name, _)| name.starts_with("probe:"))
        .unwrap()
        .1;
    for word in ["copied", "pasted", "snipped"] {
        assert!(!probe.contains(word), "{probe}");
    }
    println!("E2E: the Copy, Cut and Paste keys refused");

    // The person sends the bot's tab to the browser's own pages, then to a file: nothing but going
    // to a website works there, and the page's events and history name neither.
    for elsewhere in ["chrome://version/", "file:///etc/hosts"] {
        let (running, session) = person(&browsers);
        let to = json!({ "url": elsewhere });
        running
            .pipe
            .call("Page.navigate", to, Some(&session))
            .await
            .unwrap();
        for _ in 0..50 {
            if running
                .address()
                .await
                .unwrap()
                .starts_with(&elsewhere[..6])
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        for method in [
            "Accessibility.getFullAXTree",
            "Page.captureScreenshot",
            "Page.reload",
            "Page.getNavigationHistory",
        ] {
            let error = browsers
                .handle("bot", &json!({ "method": method }))
                .await
                .unwrap_err();
            assert_eq!(error, OFF_THE_WEB, "{method} on {elsewhere}");
        }
        let click = json!({ "method": "Input.dispatchMouseEvent", "params": { "type": "mousePressed", "x": 5, "y": 5, "button": "left", "clickCount": 1 } });
        assert_eq!(
            browsers.handle("bot", &click).await.unwrap_err(),
            OFF_THE_WEB
        );
        let back = browsers
            .handle(
                "bot",
                &json!({ "method": "Page.navigate", "params": { "url": page } }),
            )
            .await
            .unwrap();
        let named = back["events"].to_string();
        assert!(
            !named.contains("chrome://") && !named.contains("file://"),
            "{named}"
        );
        wait_for(&browsers, "Greet").await;
        let history = call(&browsers, "Page.getNavigationHistory", json!({})).await;
        assert!(!history.to_string().contains(&elsewhere[..9]), "{history}");
    }
    println!(
        "E2E: a tab moved to the browser's own pages or a file is refused until it shows a website"
    );

    // The person closes the bot's tab with only a page of the browser's own left: the bot gets a
    // new blank tab, never that one.
    let (running, _) = person(&browsers);
    let target = running.target.lock().unwrap().clone().unwrap();
    let own = json!({ "url": "chrome://version/" });
    let settings = running
        .pipe
        .call("Target.createTarget", own, None)
        .await
        .unwrap();
    let close = json!({ "targetId": target });
    running
        .pipe
        .call("Target.closeTarget", close, None)
        .await
        .unwrap();
    for _ in 0..50 {
        if running.pipe.session.lock().unwrap().is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    call(&browsers, "Page.navigate", json!({ "url": page })).await;
    wait_for(&browsers, "Greet").await;
    let attached = running.target.lock().unwrap().clone().unwrap();
    assert_ne!(Some(attached.as_str()), settings["targetId"].as_str());
    println!("E2E: with the bot's tab closed it opens a new one, not the browser's own page");

    let strict = Browsers::with(root.join("strict-profiles"), find(), true);
    let local = json!({ "method": "Page.navigate", "params": { "url": page } });
    assert!(
        strict
            .handle("bot", &local)
            .await
            .unwrap_err()
            .contains("only websites")
    );
    println!("E2E: a page on this computer is refused outside tests");

    let pid = browser_pid(&root);
    let profile = root.join("browser-profiles").join(key());
    let line = command_line(pid).expect("the browser runs");
    assert!(
        line.contains(&format!("--user-data-dir={}", profile.display())),
        "{line}"
    );
    assert!(!line.contains("--remote-debugging-port"), "{line}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&profile).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "the profile folder is the user's alone");
    }
    assert!(
        std::fs::read_dir(&profile).unwrap().next().is_some(),
        "the browser wrote its profile"
    );
    println!(
        "E2E: the profile is the bot's own ({}), mode 700",
        profile.display()
    );
    let ports = listening(pid);
    assert!(ports.is_empty(), "the browser listens on TCP: {ports:?}");
    println!("E2E: no TCP port listened on by the browser's processes");

    browsers.close_all();
    for _ in 0..100 {
        if command_line(pid).is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        command_line(pid).is_none(),
        "the browser still runs after close_all"
    );
    println!("E2E: closed with access turned off");
    let _ = std::fs::remove_dir_all(&root);
}

/// Starts the bot's browser and waits to be killed: `tests/stack_e2e_native.sh` kills this test
/// with SIGKILL and checks the browser ends with it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Chrome, Edge, Brave or Chromium; run by tests/stack_e2e_native.sh"]
async fn e2e_browser_hold_until_killed() {
    let root = root();
    let browsers = browsers(&root);
    call(&browsers, "Page.navigate", json!({ "url": serve() })).await;
    println!("E2E: browser pid {}", browser_pid(&root));
    println!("E2E: holding");
    tokio::time::sleep(Duration::from_secs(600)).await;
}

/// After a killed app left its browser running (macOS, where nothing ends it with the app), the
/// next start on that profile ends it first: `tests/stack_e2e_native.sh` runs this after
/// `e2e_browser_hold_until_killed` with the same `DOZO_BROWSER_E2E_ROOT`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Chrome, Edge, Brave or Chromium; run by tests/stack_e2e_native.sh"]
async fn e2e_browser_ends_what_a_crashed_app_left() {
    let root = root();
    let left = browser_pid(&root);
    let browsers = browsers(&root);
    call(&browsers, "Page.navigate", json!({ "url": serve() })).await;
    assert!(
        command_line(left).is_none(),
        "the browser a killed app left still runs"
    );
    assert_ne!(browser_pid(&root), left);
    println!("E2E: the next start ended the browser a killed app left");
    // The bot is deleted: its browser ends first, then its profile goes and stays gone.
    let pid = browser_pid(&root);
    browsers.close("bot", true).await;
    assert!(command_line(pid).is_none(), "the browser outlived its bot");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !root.join("browser-profiles").join(key()).exists(),
        "the profile came back"
    );
    println!("E2E: a deleted bot's browser ended before its profile was removed");
}

fn base64_decode(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in text.bytes().filter(|byte| *byte != b'=') {
        let value = ALPHABET.iter().position(|c| *c == byte).unwrap() as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

/// Serves `pages` by path on loopback, from a thread, and returns the port.
fn serve_pages(pages: Vec<(&'static str, String)>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = [0u8; 4096];
            let read = stream.read(&mut request).unwrap_or(0);
            let line = String::from_utf8_lossy(&request[..read]);
            let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
            let body = pages
                .iter()
                .find(|(at, _)| *at == path)
                .map(|(_, body)| body.as_str())
                .unwrap_or("");
            let _ = match body.strip_prefix("REDIRECT ") {
                Some(to) => write!(
                    stream,
                    "HTTP/1.1 302 Found\r\nlocation: {to}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                ),
                None => write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                ),
            };
        }
    });
    port
}

/// The guard holds where a page would reach around it: through a window it opens, a frame it adds,
/// a frame of another site (its own process), and the older full screen calls. Every attack runs
/// on a bot's click, which counts as the person's gesture.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Chrome, Edge, Brave or Chromium; run by tests/stack_e2e_native.sh"]
async fn e2e_browser_guard_holds_in_windows_and_frames() {
    const COPY: &str = "document.addEventListener('copy',e=>{e.clipboardData.setData('text/plain','x');e.preventDefault()},{once:true});";
    let script = format!(
        "<p id=probe>probe:</p><script>function r(t){{document.getElementById('probe').textContent+=' '+t}}\
         addEventListener('message',e=>r(e.data));</script>\
         <button onclick=\"{COPY}const w=window.open();r(w.Document.prototype.execCommand.call(document,'copy')?'window-wrote':'window-refused');w.close()\">Window</button>\
         <button onclick=\"{COPY}const f=document.createElement('iframe');document.body.append(f);r(frames[frames.length-1].Document.prototype.execCommand.call(document,'copy')?'frame-wrote':'frame-refused')\">Frame</button>\
         <button onclick=\"document.documentElement.webkitRequestFullScreen();setTimeout(()=>r(document.fullscreenElement?'webkit-taken':'webkit-refused'),300)\">Webkit</button>\
         <button onclick=\"{COPY}Array.prototype.includes=()=>false;String.prototype.toLowerCase=function(){{return 'bold'}};r(document.execCommand('copy')?'includes-wrote':'includes-refused')\">Includes</button>\
         <button onclick=\"{COPY}const seen=[];const call=Function.prototype.call;Function.prototype.call=function(t,...a){{seen.push(this);return Reflect.apply(this,t,a)}};Reflect.apply=(f,t,a)=>{{seen.push(f);return call.apply(f,[t,...a])}};document.execCommand('bold');const f=seen.find(x=>x&&x.name==='execCommand'&&!String(x).includes('arguments'));r(f&&call.apply(f,[document,'copy'])?'call-wrote':'call-refused')\">Call</button>\
         <button onclick=\"document.body.requestPointerLock().then(()=>r('lock-taken'),()=>r('lock-refused'))\">Lock</button>\
         <button onclick=\"(window.showOpenFilePicker?showOpenFilePicker():Promise.reject()).then(()=>r('picker-opened'),()=>r('picker-refused'))\">Picker</button>\
         <button onclick=\"(window.documentPictureInPicture?documentPictureInPicture.requestWindow():Promise.reject()).then(()=>r('pip-opened'),()=>r('pip-refused'))\">PiP</button>\
         <button onclick=\"navigator.credentials.get({{publicKey:{{challenge:new Uint8Array(16)}}}}).then(()=>r('passkey-asked'),()=>r('passkey-refused'))\">Passkey</button>\
         <button onclick=\"Notification.requestPermission().then(p=>r(p==='granted'?'notify-granted':'notify-refused'))\">Notify</button>"
    );
    let inner = format!(
        "<button style='width:100%;height:100%' onclick=\"{COPY}parent.postMessage(document.execCommand('copy')?'site-wrote':'site-refused','*')\">Inside</button>"
    );
    let port = serve_pages(vec![("/inner", inner), ("/", String::new())]);
    // The outer page names the inner one on another site (localhost against 127.0.0.1), so the
    // frame runs in a process of its own.
    let outer = format!(
        "<!doctype html><title>guard</title>{script}<iframe style='width:300px;height:80px' src='http://127.0.0.1.nip.io:{port}/inner'></iframe>"
    );
    let outer_port = serve_pages(vec![("/", outer)]);
    let root = root();
    let browsers = browsers(&root);
    let page = format!("http://127.0.0.1:{outer_port}/");
    call(&browsers, "Page.navigate", json!({ "url": page })).await;
    let found = wait_for(&browsers, "Webkit").await;
    let buttons = [
        "Window", "Frame", "Webkit", "Includes", "Call", "Lock", "Picker", "PiP", "Passkey",
        "Notify",
    ];
    for button in buttons {
        click(&browsers, find_node(&found, "button", button)).await;
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    let frame = found
        .iter()
        .find(|(role, _, _)| role == "Iframe")
        .unwrap_or_else(|| panic!("no frame in {found:?}"));
    click(&browsers, frame.2).await;
    let mut probe = String::new();
    for _ in 0..50 {
        probe = nodes(&browsers)
            .await
            .into_iter()
            .find(|(_, name, _)| name.starts_with("probe:"))
            .map(|(_, name, _)| name)
            .unwrap_or_default();
        if probe.split(' ').count() == buttons.len() + 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut outcomes: Vec<&str> = probe.split(' ').skip(1).collect();
    outcomes.sort_unstable();
    assert_eq!(
        outcomes,
        [
            "call-refused",
            "frame-refused",
            "includes-refused",
            "lock-refused",
            "notify-refused",
            "passkey-refused",
            "picker-refused",
            "pip-refused",
            "site-refused",
            "webkit-refused",
            "window-refused",
        ],
        "{probe}"
    );
    println!(
        "E2E: the guard holds in a window the page opens, a frame it adds, a frame of another site, the older full screen, against a page that replaces what it relies on, and for pointer lock, pickers, picture-in-picture, passkeys and notifications"
    );
    browsers.close_all();
}

/// Nothing the page does reaches this computer or its network: not a picture, a script's request,
/// a form, a redirect, or a public name that resolves to loopback. A port that answers and one
/// that does not look the same. The test's page is on a loopback port the proxy lets through; the
/// target, another loopback port, counts every request it gets.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Chrome, Edge, Brave or Chromium; run by tests/stack_e2e_native.sh"]
async fn e2e_browser_reaches_nothing_on_this_computer_or_its_network() {
    use std::sync::atomic::AtomicUsize;
    let hits = Arc::new(AtomicUsize::new(0));
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = target.local_addr().unwrap().port();
    let counted = hits.clone();
    std::thread::spawn(move || {
        for mut stream in target.incoming().flatten() {
            counted.fetch_add(1, Ordering::SeqCst);
            let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
        }
    });
    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let home = format!(
        "<!doctype html><title>reach</title><p id=probe>probe:</p>\
         <script>function r(t){{document.getElementById('probe').textContent+=' '+t}}</script>\
         <img src='http://127.0.0.1:{port}/img'>\
         <button onclick=\"fetch('http://127.0.0.1:{port}/f',{{mode:'no-cors'}}).then(()=>r('fetch-done'),()=>r('fetch-done'))\">Fetch</button>"
    );
    let form = format!(
        "<!doctype html><title>form</title><form method=post action='http://127.0.0.1:{port}/form'><button>Post</button></form>"
    );
    let page = serve_pages(vec![
        ("/", home),
        ("/form", form),
        ("/away", format!("REDIRECT http://127.0.0.1:{port}/r")),
    ]);
    let root = root();
    let program = find().expect("a Chromium-family browser on this computer");
    let window = std::env::var_os("DOZO_BROWSER_E2E_WINDOW").is_some();
    let browsers = Browsers::with(root.join("browser-profiles"), Some(program), !window)
        .with_local_ports(vec![page]);
    let at = |path: &str| format!("http://127.0.0.1:{page}{path}");
    call(&browsers, "Page.navigate", json!({ "url": at("/") })).await;
    let found = wait_for(&browsers, "Fetch").await;
    click(&browsers, find_node(&found, "button", "Fetch")).await;
    // The request ends either way (the proxy answers it); only the target's count tells.
    wait_for(&browsers, "fetch-").await;
    call(&browsers, "Page.navigate", json!({ "url": at("/form") })).await;
    let form = wait_for(&browsers, "Post").await;
    click(&browsers, find_node(&form, "button", "Post")).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    call(&browsers, "Page.navigate", json!({ "url": at("/away") })).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let rebound = format!("http://127.0.0.1.nip.io:{port}/");
    let to_target = call(&browsers, "Page.navigate", json!({ "url": rebound })).await;
    let shut = format!("http://127.0.0.1.nip.io:{closed}/");
    let to_closed = call(&browsers, "Page.navigate", json!({ "url": shut })).await;
    assert_eq!(
        to_target["errorText"], to_closed["errorText"],
        "an open port looks like a closed one"
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "a request reached the target"
    );
    println!(
        "E2E: no picture, script request, form, redirect or rebound name reached this computer; open and closed ports look alike"
    );
    browsers.close_all();
}

/// The person's answer, held by the test: who was asked, and the answer to give.
#[derive(Default)]
struct HeldPrompt {
    asked: Mutex<Option<String>>,
    answer: Mutex<Option<oneshot::Sender<bool>>>,
    ended: Mutex<Vec<String>>,
}

impl SignInPrompt for HeldPrompt {
    fn ask(&self, site: &str) -> oneshot::Receiver<bool> {
        let (answer, answered) = oneshot::channel();
        *self.asked.lock().unwrap() = Some(site.to_owned());
        *self.answer.lock().unwrap() = Some(answer);
        answered
    }

    fn ended(&self, site: &str) {
        self.ended.lock().unwrap().push(site.to_owned());
    }
}

/// While the person signs in, the bot's browser passes nothing on: no page, screenshot, input,
/// navigation or history, and what the sign-in went through (a code in a return address) never
/// reaches the server, during it or after. Only the person's Done ends it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Chrome, Edge, Brave or Chromium; run by tests/stack_e2e_native.sh"]
async fn e2e_browser_sign_in_passes_nothing_on_until_the_person_is_done() {
    let port = serve_pages(vec![
        (
            "/",
            "<!doctype html><title>Home</title><button>Account</button><button onclick=\"history.go(-2)\">Back</button>".to_owned(),
        ),
        (
            "/callback?code=SECRET",
            "<!doctype html><title>Back</title>signed in".to_owned(),
        ),
    ]);
    let site = format!("127.0.0.1:{port}");
    let root = root();
    let browsers = Arc::new(browsers(&root).with_sign_in_time(Duration::from_secs(10)));
    let prompt = Arc::new(HeldPrompt::default());
    browsers.set_sign_in_prompt(prompt.clone());
    call(
        &browsers,
        "Page.navigate",
        json!({ "url": format!("http://{site}/") }),
    )
    .await;
    let signing = {
        let (browsers, site) = (browsers.clone(), site.clone());
        tokio::spawn(async move { browsers.sign_in("bot", &site).await })
    };
    for _ in 0..100 {
        if prompt.asked.lock().unwrap().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(prompt.asked.lock().unwrap().as_deref(), Some(site.as_str()));
    // The person goes through the sign-in, which comes back with a code in its address.
    let (running, session) = person(&browsers);
    let back = json!({ "url": format!("http://{site}/callback?code=SECRET") });
    running
        .pipe
        .call("Page.navigate", back, Some(&session))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    for command in [
        json!({ "method": "Accessibility.getFullAXTree" }),
        json!({ "method": "Page.captureScreenshot", "params": { "format": "png" } }),
        json!({ "method": "Page.getNavigationHistory" }),
        json!({ "method": "Input.insertText", "params": { "text": "x" } }),
        json!({ "method": "Page.navigate", "params": { "url": format!("http://{site}/") } }),
    ] {
        let error = browsers.handle("bot", &command).await.unwrap_err();
        assert!(error.contains("signing in"), "{command}: {error}");
    }
    let again = browsers.sign_in("bot", &site).await.unwrap_err();
    assert!(again.contains("signing in"), "{again}");
    assert!(!signing.is_finished(), "only the person ends it");
    println!("E2E: while the person signs in every command is refused");
    prompt
        .answer
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .send(true)
        .unwrap();
    assert!(
        signing.await.unwrap().unwrap(),
        "the person said they signed in"
    );
    let answer = browsers
        .handle("bot", &json!({ "method": "Page.getNavigationHistory" }))
        .await
        .unwrap();
    assert!(!answer.to_string().contains("SECRET"), "{answer}");
    // The page is the site's home now, not the return address: no answer names the code, and
    // the history entry the sign-in made cannot be gone back to.
    for method in ["Page.getFrameTree", "DOM.getDocument"] {
        let answer = call(&browsers, method, json!({})).await;
        assert!(!answer.to_string().contains("SECRET"), "{method}: {answer}");
    }
    let tree = call(&browsers, "Accessibility.getFullAXTree", json!({})).await;
    assert!(
        tree.to_string().contains("Account"),
        "the page is the site's home"
    );
    // The tab keeps no way back: a page that goes back, or a Back link the bot clicks, finds
    // nothing behind it, and the history is the home page alone.
    let home = wait_for(&browsers, "Back").await;
    click(&browsers, find_node(&home, "button", "Back")).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    for method in [
        "Page.getFrameTree",
        "DOM.getDocument",
        "Page.getNavigationHistory",
    ] {
        let answer = browsers
            .handle("bot", &json!({ "method": method }))
            .await
            .unwrap();
        assert!(!answer.to_string().contains("SECRET"), "{method}: {answer}");
    }
    let entries = call(&browsers, "Page.getNavigationHistory", json!({})).await;
    assert_eq!(entries["entries"].as_array().unwrap().len(), 1, "{entries}");
    println!(
        "E2E: after Done the page is the site's home, and no address of the sign-in reaches the server"
    );
    // A cancelled sign-in leaves a blank page, not what the person had started there.
    let cancelling = {
        let (browsers, site) = (browsers.clone(), site.clone());
        tokio::spawn(async move { browsers.sign_in("bot", &site).await })
    };
    for _ in 0..100 {
        if prompt.answer.lock().unwrap().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    prompt
        .answer
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .send(false)
        .unwrap();
    assert!(!cancelling.await.unwrap().unwrap(), "the person cancelled");
    let after = call(&browsers, "Accessibility.getFullAXTree", json!({})).await;
    assert!(
        !after.to_string().contains("Account"),
        "a cancelled sign-in left its page: {after}"
    );
    println!("E2E: a cancelled sign-in leaves a blank page");
    // One nobody answers counts as cancelled when its time runs out, and the person is told.
    *prompt.answer.lock().unwrap() = None;
    let unanswered = browsers.sign_in("bot", &site).await.unwrap();
    assert!(!unanswered, "an unanswered sign-in is cancelled");
    assert_eq!(*prompt.ended.lock().unwrap(), vec![site.clone()]);
    assert!(browsers.signing_site("bot").is_none());
    println!("E2E: an unanswered sign-in ends when its time runs out, and the person is told");
    browsers.close_all();
}

/// A plain HTTP server that keeps each connection open for more requests and records the host
/// every request named; returns its port and the record.
fn keep_alive_server(body: &'static str) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let hosts = Arc::new(Mutex::new(Vec::new()));
    let seen = hosts.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let seen = seen.clone();
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let Ok(read) = stream.read(&mut chunk) else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    while let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head: Vec<u8> = buffer.drain(..end + 4).collect();
                        let head = String::from_utf8_lossy(&head).to_lowercase();
                        let host = head
                            .lines()
                            .find_map(|line| line.strip_prefix("host: "))
                            .unwrap_or("")
                            .to_owned();
                        seen.lock().unwrap().push(host);
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\n\r\n{body}",
                            body.len()
                        );
                    }
                }
            });
        }
    });
    (port, hosts)
}

/// A plain HTTP request for one site never goes to another site's server, even if the browser
/// sends a second request on the proxy connection it used for the first.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Chrome, Edge, Brave or Chromium; run by tests/stack_e2e_native.sh"]
async fn e2e_browser_plain_requests_reach_only_their_own_site() {
    let (a, a_hosts) = keep_alive_server("<!doctype html><title>A</title><p>site a</p>");
    let (b, b_hosts) = keep_alive_server("<!doctype html><title>B</title><p>site b</p>");
    let root = root();
    let program = find().expect("a Chromium-family browser on this computer");
    let browsers = Browsers::with(root.join("browser-profiles"), Some(program), true)
        .with_local_ports(vec![a, b]);
    for round in 0..4 {
        for (port, name) in [(a, "site a"), (b, "site b")] {
            let url = format!("http://127.0.0.1:{port}/{round}");
            call(&browsers, "Page.navigate", json!({ "url": url })).await;
            wait_for(&browsers, name).await;
        }
    }
    let wrong = |hosts: &Arc<Mutex<Vec<String>>>, port: u16| {
        hosts
            .lock()
            .unwrap()
            .iter()
            .filter(|host| !host.ends_with(&format!(":{port}")))
            .count()
    };
    let (to_a, to_b) = (a_hosts.lock().unwrap().len(), b_hosts.lock().unwrap().len());
    let misrouted = wrong(&a_hosts, a) + wrong(&b_hosts, b);
    let reused = browsers
        .proxy
        .lock()
        .await
        .as_ref()
        .map_or(0, |proxy| proxy.reused.load(Ordering::SeqCst));
    println!(
        "E2E: {to_a} requests reached site a and {to_b} site b; {misrouted} named the other site; the browser sent {reused} requests on a proxy connection it had used, each closed and sent again"
    );
    assert_eq!(misrouted, 0, "a request reached another site's server");
    browsers.close_all();
}
