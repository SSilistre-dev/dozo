//! Tests of the agent runner (`device_agent.rs`). The fake agent is this test binary itself,
//! started again by a tiny `agy` script on the test's own PATH (`fake_agent` returns at once
//! when `DOZO_FAKE` is not set). Offline, and no other program is needed.

use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use super::*;
use crate::device_run::{CANCELLED, LOST, Reply, Runner, bot_key};

const REQUESTS: &str =
    include_str!("../../../packages/adapters/src/dozo-agent-device-fixtures/requests.json");
const FRAMES: &str =
    include_str!("../../../packages/adapters/src/dozo-agent-device-fixtures/frames.json");

/// The catalog the tests run with: the real entry's words, verified.
static VERIFIED: &[Entry] = &[Entry {
    id: "antigravity-agent",
    name: "Antigravity",
    command: "agy",
    args: &["acp"],
    min: [1, 5, 0],
    below: [1, 6, 0],
    terms: None,
    verified: true,
}];

/// Another agent, under another name.
static OTHER: &[Entry] = &[Entry {
    id: "fake-agent",
    name: "Fake",
    command: "agy",
    args: &["acp", "extra"],
    min: [1, 5, 0],
    below: [1, 6, 0],
    terms: None,
    verified: true,
}];

// ---------------------------------------------------------------------------------------------
// The fake agent.

#[test]
fn fake_agent() {
    let Ok(scenario) = std::env::var("DOZO_FAKE") else {
        return;
    };
    fake::run(&scenario);
}

mod fake {
    use super::*;
    use std::io::BufReader;
    use std::os::unix::net::UnixStream;

    struct Fake {
        input: std::io::Lines<BufReader<std::io::Stdin>>,
        log: PathBuf,
        cancelled: bool,
        next: u64,
    }

    impl Fake {
        fn log(&self, entry: Value) {
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.log)
                .unwrap();
            writeln!(file, "{entry}").unwrap();
        }

        fn send(&self, message: Value) {
            let mut message = message;
            message["jsonrpc"] = json!("2.0");
            let mut out = std::io::stdout().lock();
            writeln!(out, "{message}").unwrap();
            out.flush().unwrap();
        }

        fn read(&mut self) -> Option<Value> {
            loop {
                let line = self.input.next()?.ok()?;
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message["method"] == "session/cancel" {
                    self.cancelled = true;
                    self.log(json!({ "cancel": true }));
                }
                return Some(message);
            }
        }

        /// A request to the client, and its answer.
        fn call(&mut self, method: &str, params: Value) -> Value {
            self.next += 1;
            let id = 900 + self.next;
            self.send(json!({ "id": id, "method": method, "params": params }));
            loop {
                let message = self.read().expect("the client went away");
                if message["id"] == id && message.get("method").is_none() {
                    return message;
                }
            }
        }

        fn chunk(&self, text: &str) {
            self.update(json!({ "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text } }));
        }

        fn update(&self, update: Value) {
            self.send(json!({ "method": "session/update",
                "params": { "sessionId": "s-1", "update": update } }));
        }

        fn until_cancelled(&mut self) {
            while !self.cancelled {
                if self.read().is_none() {
                    return;
                }
            }
        }
    }

    fn permission(fake: &mut Fake, options: &Value, tool_call: Value) -> Value {
        fake.call(
            "session/request_permission",
            json!({ "sessionId": "s-1", "toolCall": tool_call, "options": options }),
        )
    }

    pub fn run(scenario: &str) {
        let log = PathBuf::from(std::env::var("DOZO_FAKE_LOG").unwrap());
        let outside = std::env::var("DOZO_FAKE_OUTSIDE").unwrap_or_default();
        let cwd = std::env::current_dir().unwrap();
        let mut fake = Fake {
            input: BufReader::new(std::io::stdin()).lines(),
            log,
            cancelled: false,
            next: 0,
        };
        let mut env: Vec<String> = std::env::vars().map(|(name, _)| name).collect();
        env.sort();
        fake.log(json!({ "started": { "cwd": cwd, "env": env,
            "home": std::env::var("HOME").ok(), "path": std::env::var("PATH").ok() } }));
        let all = json!([
            { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
            { "optionId": "once", "name": "Allow", "kind": "allow_once" },
            { "optionId": "no", "name": "Reject", "kind": "reject_once" },
            { "optionId": "never", "name": "Always reject", "kind": "reject_always" },
        ]);
        let always_only = json!([all[0], all[3]]);
        let tool = json!({ "toolCallId": "c1", "title": "Run ls", "kind": "execute",
            "locations": [{ "path": "/w/a" }], "rawInput": { "command": "ls" } });
        let mut prompts = 0;
        while let Some(message) = fake.read() {
            let id = message["id"].clone();
            match message["method"].as_str() {
                Some("initialize") => {
                    let version = if scenario == "old" { "1.7.0" } else { "1.5.13" };
                    let protocol = if scenario == "protocol" { 2 } else { 1 };
                    fake.log(json!({ "initialize": message["params"] }));
                    fake.send(json!({ "id": id, "result": { "protocolVersion": protocol,
                        "agentInfo": { "name": "agy", "version": version }, "authMethods": [] } }));
                }
                Some("session/new") => {
                    if scenario == "unauth" {
                        fake.send(json!({ "id": id,
                            "error": { "code": -32000, "message": "Authentication required" } }));
                        continue;
                    }
                    if scenario == "slow-new" {
                        std::thread::sleep(Duration::from_millis(800));
                    }
                    fake.log(json!({ "new": message["params"] }));
                    fake.send(json!({ "id": id, "result": { "sessionId": "s-1" } }));
                }
                Some("session/prompt") => {
                    prompts += 1;
                    fake.log(json!({ "prompt": message["params"]["prompt"][0]["text"] }));
                    let end = |fake: &Fake, reason: &str| {
                        fake.send(json!({ "id": id, "result": { "stopReason": reason } }));
                    };
                    match scenario {
                        "reply" | "old" | "protocol" | "slow-new" => {
                            fake.update(json!({ "sessionUpdate": "tool_call",
                                "toolCallId": "t1", "title": "Reading notes" }));
                            fake.update(json!({ "sessionUpdate": "plan", "entries": [] }));
                            fake.chunk("Hello ");
                            fake.chunk("there");
                            end(&fake, "end_turn");
                        }
                        "chunks" => {
                            fake.chunk("a");
                            fake.chunk("b");
                            fake.chunk("c");
                            std::thread::sleep(Duration::from_millis(400));
                            fake.chunk("d");
                            fake.chunk(&"x".repeat(40_000));
                            end(&fake, "end_turn");
                        }
                        "refusal" => end(&fake, "refusal"),
                        "cancelled" => end(&fake, "cancelled"),
                        "odd" => end(&fake, "weird"),
                        "permission" | "permission-no-once" => {
                            let options = if scenario == "permission" {
                                &all
                            } else {
                                &always_only
                            };
                            let answer = permission(&mut fake, options, tool.clone());
                            fake.log(json!({ "outcome": answer["result"]["outcome"] }));
                            fake.chunk("after");
                            end(&fake, "end_turn");
                        }
                        "read-inside" | "read-limit" | "read-outside" | "read-link" => {
                            let path = match scenario {
                                "read-outside" => PathBuf::from(&outside).join("secret.txt"),
                                "read-link" => cwd.join("link/secret.txt"),
                                _ => cwd.join("note.txt"),
                            };
                            let mut params = json!({ "sessionId": "s-1", "path": path });
                            if scenario == "read-limit" {
                                params["line"] = json!(2);
                                params["limit"] = json!(1);
                            }
                            let answer = fake.call("fs/read_text_file", params);
                            fake.log(json!({ "read": answer }));
                            fake.chunk("read done");
                            end(&fake, "end_turn");
                        }
                        "write" => {
                            let answer = fake.call("fs/write_text_file", json!({
                                "sessionId": "s-1", "path": cwd.join("out.txt"), "content": "written" }));
                            fake.log(json!({ "write": answer }));
                            end(&fake, "end_turn");
                        }
                        "terminal" => {
                            let answer = fake.call("terminal/create", json!({ "command": "ls" }));
                            fake.log(json!({ "terminal": answer }));
                            end(&fake, "end_turn");
                        }
                        "bridge" | "badkey" | "bigargs" => bridge(&mut fake, scenario, &id),
                        "hang" | "hang-once" => {
                            if scenario == "hang" || prompts == 1 {
                                fake.until_cancelled();
                                fake.cancelled = false;
                                end(&fake, "cancelled");
                            } else {
                                fake.chunk("ok");
                                end(&fake, "end_turn");
                            }
                        }
                        "child" => {
                            #[allow(clippy::zombie_processes)] // Left for the group's end to stop.
                            let child = std::process::Command::new("sleep")
                                .arg("30")
                                .spawn()
                                .unwrap();
                            fake.log(json!({ "child": child.id() }));
                            fake.chunk("up");
                            end(&fake, "end_turn");
                        }
                        "write-link" | "write-race" => {
                            let name = if scenario == "write-link" {
                                "dang"
                            } else {
                                "out.txt"
                            };
                            let answer = fake.call(
                                "fs/write_text_file",
                                json!({
                                "sessionId": "s-1", "path": cwd.join(name), "content": "written" }),
                            );
                            fake.log(json!({ "write": answer }));
                            end(&fake, "end_turn");
                        }
                        "read-fifo" => {
                            let answer = fake.call(
                                "fs/read_text_file",
                                json!({
                                "sessionId": "s-1", "path": cwd.join("pipe") }),
                            );
                            fake.log(json!({ "read": answer }));
                            end(&fake, "end_turn");
                        }
                        "permission-twice" => {
                            for id in [801, 802] {
                                fake.send(
                                    json!({ "id": id, "method": "session/request_permission",
                                    "params": { "sessionId": "s-1", "toolCall": tool.clone(),
                                        "options": all.clone() } }),
                                );
                            }
                            let mut got = Vec::new();
                            while got.len() < 2 {
                                let message = fake.read().unwrap();
                                if message.get("method").is_none()
                                    && message["id"].as_u64() > Some(800)
                                {
                                    got.push(json!([message["id"], message["result"]["outcome"]]));
                                }
                            }
                            fake.log(json!({ "twice": got }));
                            end(&fake, "end_turn");
                        }
                        "bigline" => {
                            fake.chunk(&"x".repeat(5 * 1024 * 1024));
                            end(&fake, "end_turn");
                        }
                        "flood" => {
                            for _ in 0..2000 {
                                fake.chunk("x");
                            }
                            end(&fake, "end_turn");
                        }
                        "outside-tool-deaf" => {
                            fake.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "t1",
                                "title": "Read secret", "kind": "read", "status": "in_progress",
                                "locations": [{ "path": format!("{outside}/secret.txt") }] }));
                            std::thread::sleep(Duration::from_secs(120));
                        }
                        "permission-long" | "permission-bidi" | "permission-newline" => {
                            let mut call = tool.clone();
                            match scenario {
                                "permission-long" => {
                                    call["rawInput"] = json!({ "command": "x".repeat(5000) });
                                }
                                "permission-bidi" => call["title"] = json!("Run \u{202E}sl"),
                                _ => call["rawInput"] = json!({ "command": "ls\nrm -rf /" }),
                            }
                            let answer = permission(&mut fake, &all, call);
                            fake.log(json!({ "outcome": answer["result"]["outcome"] }));
                            fake.chunk("after");
                            end(&fake, "end_turn");
                        }
                        "permission-many" => {
                            for _ in 0..5 {
                                let answer = permission(&mut fake, &all, tool.clone());
                                fake.log(json!({ "outcome": answer["result"]["outcome"] }));
                            }
                            end(&fake, "end_turn");
                        }
                        "permission-flood" => {
                            for id in 801..=806 {
                                fake.send(
                                    json!({ "id": id, "method": "session/request_permission",
                                    "params": { "sessionId": "s-1", "toolCall": tool.clone(),
                                        "options": all.clone() } }),
                                );
                            }
                            fake.until_cancelled();
                            end(&fake, "cancelled");
                        }
                        "write-newline-path" => {
                            let answer = fake.call(
                                "fs/write_text_file",
                                json!({
                                "sessionId": "s-1", "path": cwd.join("a\nb.txt"), "content": "x" }),
                            );
                            fake.log(json!({ "write": answer }));
                            end(&fake, "end_turn");
                        }
                        "read-race" => {
                            let answer = fake.call(
                                "fs/read_text_file",
                                json!({
                                "sessionId": "s-1", "path": format!("{outside}/sub/secret.txt") }),
                            );
                            fake.log(json!({ "read": answer }));
                            end(&fake, "end_turn");
                        }
                        "outside-tool" => {
                            fake.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "t1",
                                "title": "Read secret", "kind": "read", "status": "in_progress",
                                "locations": [{ "path": format!("{outside}/secret.txt") }] }));
                            fake.until_cancelled();
                            end(&fake, "cancelled");
                        }
                        "outside-tool-approved" => {
                            let place = format!("{outside}/secret.txt");
                            fake.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "t1",
                                "title": "Read secret", "kind": "read", "status": "pending",
                                "locations": [{ "path": place }] }));
                            let answer = permission(
                                &mut fake,
                                &all,
                                json!({ "toolCallId": "t1",
                                "title": "Read secret", "kind": "read",
                                "locations": [{ "path": place }] }),
                            );
                            fake.log(json!({ "outcome": answer["result"]["outcome"] }));
                            fake.update(json!({ "sessionUpdate": "tool_call_update",
                                "toolCallId": "t1", "status": "in_progress" }));
                            fake.chunk("went on");
                            end(&fake, "end_turn");
                        }
                        other => panic!("no scenario {other}"),
                    }
                }
                _ => {}
            }
        }
    }

    /// The agent's own MCP client: the bridge's socket, as `session/new` gave it.
    fn bridge(fake: &mut Fake, scenario: &str, prompt_id: &Value) {
        let params = fake.log_param();
        let env = &params["mcpServers"][0]["env"];
        let value = |name: &str| {
            env.as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["name"] == name)
                .map(|entry| entry["value"].as_str().unwrap().to_owned())
                .unwrap()
        };
        let mut socket = UnixStream::connect(value("DOZO_BRIDGE_SOCKET")).unwrap();
        let key = if scenario == "badkey" {
            "0".repeat(64)
        } else {
            value("DOZO_BRIDGE_KEY")
        };
        let mut lines = BufReader::new(socket.try_clone().unwrap());
        let mut ask = |message: Value| -> Option<Value> {
            let mut message = message;
            message["key"] = json!(key);
            writeln!(socket, "{message}").ok()?;
            let mut line = String::new();
            (lines.read_line(&mut line).ok()? > 0).then(|| serde_json::from_str(&line).unwrap())
        };
        match scenario {
            "badkey" => {
                let answer = ask(json!({ "id": 1, "method": "list" }));
                fake.log(json!({ "badkey": answer }));
            }
            "bigargs" => {
                let answer = ask(json!({ "id": 1, "method": "call", "name": "memory_search",
                    "arguments": { "x": "a".repeat(300_000) } }));
                fake.log(json!({ "bigargs": answer }));
            }
            _ => {
                let list = ask(json!({ "id": 1, "method": "list" }));
                fake.log(json!({ "list": list }));
                let call = ask(json!({ "id": 2, "method": "call", "name": "memory_search",
                    "arguments": { "query": "notes" } }));
                fake.log(json!({ "call": call }));
                let unknown = ask(json!({ "id": 3, "method": "call", "name": "nope",
                    "arguments": {} }));
                fake.log(json!({ "unknown": unknown }));
            }
        }
        fake.chunk("bridged");
        fake.send(json!({ "id": prompt_id, "result": { "stopReason": "end_turn" } }));
    }

    impl Fake {
        /// The `session/new` parameters, as logged.
        fn log_param(&self) -> Value {
            std::fs::read_to_string(&self.log)
                .unwrap()
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find_map(|entry| entry.get("new").cloned())
                .unwrap()
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The test bench.

struct TestApprovals {
    answers: Mutex<VecDeque<Option<bool>>>,
    asked: Mutex<Vec<String>>,
    held: Mutex<Vec<oneshot::Sender<bool>>>,
    /// Runs while the question is open, before it is answered.
    before: Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl TestApprovals {
    fn new(answers: &[Option<bool>]) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.iter().copied().collect()),
            asked: Mutex::default(),
            held: Mutex::default(),
            before: Mutex::default(),
        })
    }
    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

impl Approvals for TestApprovals {
    fn ask(&self, text: &str) -> oneshot::Receiver<bool> {
        self.asked.lock().unwrap().push(text.to_owned());
        if let Some(before) = self.before.lock().unwrap().as_ref() {
            before();
        }
        let (send, receive) = oneshot::channel();
        match self.answers.lock().unwrap().pop_front() {
            Some(Some(answer)) => {
                let _ = send.send(answer);
            }
            _ => self.held.lock().unwrap().push(send),
        }
        receive
    }
}

/// The one `agy` the tests share: it reads its scenario from the file `$HOME/.fake-env`, a data
/// file, so no script is written while other tests start programs.
fn bin() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("dozo-fake-agy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("agy");
        std::fs::write(
            &script,
            "#!/bin/sh\n. \"$HOME/.fake-env\"\nprintf '%s\\n' \"$@\" > \"$DOZO_FAKE_LOG.args\"\n\
             exec \"$DOZO_FAKE_EXE\" --exact device_agent::tests::fake_agent --nocapture\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        dir
    })
}

struct Bench {
    dir: PathBuf,
    runner: Arc<Runner>,
    approvals: Arc<TestApprovals>,
}

fn bench(scenario: &str, answers: &[Option<bool>]) -> Bench {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "dozo-agent-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("home")).unwrap();
    std::fs::create_dir_all(dir.join("outside")).unwrap();
    std::fs::write(dir.join("outside/secret.txt"), "top secret").unwrap();
    std::fs::write(
        dir.join("home/.fake-env"),
        format!(
            "export DOZO_FAKE='{scenario}'\nexport DOZO_FAKE_LOG='{}'\nexport DOZO_FAKE_OUTSIDE='{}'\nexport DOZO_FAKE_EXE='{}'\n",
            dir.join("log").display(),
            dir.join("outside").display(),
            std::env::current_exe().unwrap().display()
        ),
    )
    .unwrap();
    let runner = Runner::new(dir.join("data"), dir.join("home"));
    let approvals = TestApprovals::new(answers);
    let agents = runner.agents();
    agents.set_catalog(VERIFIED);
    agents.set_path(format!("{}:/usr/bin:/bin", bin().display()));
    agents.set_approvals(approvals.clone());
    agents.set_enabled("antigravity-agent", true);
    Bench {
        dir,
        runner,
        approvals,
    }
}

impl Bench {
    fn log(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.join("log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
    fn logged(&self, key: &str) -> Option<Value> {
        self.log()
            .into_iter()
            .find_map(|entry| entry.get(key).cloned())
    }
    fn folder(&self, bot: &str) -> PathBuf {
        self.runner.bot_home(bot)
    }
}

fn turn(run: &str, input: &str) -> Value {
    json!({ "method": "agentTurn", "botId": "bot-1", "runId": run, "agent": "antigravity-agent",
        "instructions": "Be kind.", "input": input, "tools": [] })
}

fn with_tools(mut request: Value) -> Value {
    request["tools"] = json!([{ "name": "memory_search", "description": "Search.",
        "inputSchema": { "type": "object" } }]);
    request
}

struct Call {
    frames: mpsc::Receiver<String>,
    cancel: watch::Sender<u8>,
}

fn reply(id: &str) -> (Reply, Call) {
    let (out, frames) = mpsc::channel(256);
    let (cancel, cancelled) = watch::channel(0);
    (
        Reply {
            id: id.to_owned(),
            out,
            cancel: cancelled,
        },
        Call { frames, cancel },
    )
}

fn decode(text: &str) -> Value {
    let frame: Value = serde_json::from_str(text).unwrap();
    assert_eq!(frame["type"], "frame");
    frame["frame"].clone()
}

/// Everything the request answers, until its handler returns.
async fn frames(runner: &Arc<Runner>, request: Value) -> Vec<Value> {
    let (reply, mut call) = reply("r1");
    tokio::time::timeout(Duration::from_secs(30), runner.handle(&request, &reply))
        .await
        .expect("the request ended");
    drop(reply);
    let mut all = Vec::new();
    while let Some(frame) = call.frames.recv().await {
        all.push(decode(&frame));
    }
    all
}

/// The frame values of a stream, which must all be the wire's own.
fn values(frames: &[Value]) -> Vec<Value> {
    let mut values = Vec::new();
    for frame in frames {
        if let Some(value) = frame.get("value") {
            assert!(frame_ok(value), "not a frame of the protocol: {value}");
            values.push(value.clone());
        } else {
            let known = frame == &json!({ "done": true })
                || frame == &json!({ "heartbeat": true })
                || frame["error"].is_string();
            assert!(known, "not an envelope of the protocol: {frame}");
        }
    }
    values
}

fn kinds(frames: &[Value]) -> Vec<String> {
    values(frames)
        .iter()
        .map(|v| v["type"].as_str().unwrap().to_owned())
        .collect()
}

fn ends_with_done(frames: &[Value]) {
    assert_eq!(frames.last(), Some(&json!({ "done": true })), "{frames:?}");
}

fn failed_message(frames: &[Value]) -> String {
    values(frames)
        .iter()
        .find(|v| v["type"] == "failed")
        .map(|v| v["message"].as_str().unwrap().to_owned())
        .unwrap_or_else(|| panic!("no failed frame in {frames:?}"))
}

fn texts(frames: &[Value]) -> Vec<String> {
    values(frames)
        .iter()
        .filter(|v| v["type"] == "text")
        .map(|v| v["text"].as_str().unwrap().to_owned())
        .collect()
}

fn error_of(frames: &[Value]) -> String {
    frames
        .iter()
        .find_map(|frame| frame["error"].as_str())
        .unwrap_or_else(|| panic!("no error in {frames:?}"))
        .to_owned()
}

/// The protocol's frame schema (`dozo-agent-device-protocol.ts`, `agentTurnFrame`), strictly.
fn frame_ok(frame: &Value) -> bool {
    let Some(object) = frame.as_object() else {
        return false;
    };
    let only = |keys: &[&str]| object.keys().all(|key| keys.contains(&key.as_str()));
    let text = |key: &str, max: usize| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|s| s.encode_utf16().count() <= max)
    };
    let name_ok = |name: &str| {
        (1..=128).contains(&name.len())
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    };
    match object.get("type").and_then(Value::as_str) {
        Some("started" | "done") => only(&["type"]),
        Some("text") => only(&["type", "text"]) && text("text", 64 * 1024),
        Some("activity") => only(&["type", "text"]) && text("text", 1024),
        Some("approvalWaiting" | "approvalExpired") => {
            only(&["type", "summary"]) && text("summary", 1024)
        }
        Some("toolCall") => {
            only(&["type", "callId", "name", "args"])
                && object
                    .get("callId")
                    .and_then(Value::as_str)
                    .is_some_and(|c| (1..=64).contains(&c.len()))
                && object
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(name_ok)
                && object
                    .get("args")
                    .is_some_and(|a| a.is_object() && a.to_string().len() <= 256 * 1024)
        }
        Some("limit") => {
            only(&["type", "resetsAt"])
                && object
                    .get("resetsAt")
                    .is_none_or(|at| at.as_u64().is_some_and(|at| at > 0))
        }
        Some("failed") => only(&["type", "message"]) && text("message", 4096),
        _ => false,
    }
}

async fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..200 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Whether the process ended: on Linux also a zombie, which /proc shows; elsewhere (macOS has no
/// /proc) when signal 0 finds no such process.
fn gone(pid: u64) -> bool {
    #[cfg(target_os = "linux")]
    {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            Ok(stat) => stat
                .rsplit_once(')')
                .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return true;
        };
        // SAFETY: signal 0 only asks whether the process exists; nothing is sent.
        unsafe { libc::kill(pid, 0) != 0 }
    }
}

/// Runs a turn on a task and hands back what it sends as it comes.
struct Running {
    frames: mpsc::Receiver<String>,
    cancel: watch::Sender<u8>,
    task: tokio::task::JoinHandle<()>,
}

fn start(runner: &Arc<Runner>, request: Value) -> Running {
    let (reply, call) = reply("live");
    let runner = runner.clone();
    let task = tokio::spawn(async move { runner.handle(&request, &reply).await });
    Running {
        frames: call.frames,
        cancel: call.cancel,
        task,
    }
}

impl Running {
    /// The next frame value of this type, with everything before it.
    async fn until(&mut self, kind: &str) -> (Vec<Value>, Value) {
        let mut seen = Vec::new();
        loop {
            let text = tokio::time::timeout(Duration::from_secs(20), self.frames.recv())
                .await
                .expect("a frame in time")
                .expect("the stream ended");
            let frame = decode(&text);
            if frame["value"]["type"] == kind {
                return (seen, frame["value"].clone());
            }
            seen.push(frame);
        }
    }

    async fn finish(mut self) -> Vec<Value> {
        tokio::time::timeout(Duration::from_secs(30), &mut self.task)
            .await
            .unwrap()
            .unwrap();
        let mut rest = Vec::new();
        while let Ok(text) = self.frames.try_recv() {
            rest.push(decode(&text));
        }
        rest
    }
}

// ---------------------------------------------------------------------------------------------
// The wire.

#[test]
fn every_valid_request_of_the_fixtures_is_accepted_and_every_invalid_one_refused() {
    let fixtures: Value = serde_json::from_str(REQUESTS).unwrap();
    let valid = fixtures["valid"].as_array().unwrap();
    assert!(!valid.is_empty());
    for request in valid {
        assert!(parse_request(request).is_some(), "refused: {request}");
    }
    let invalid = fixtures["invalid"].as_array().unwrap();
    assert!(invalid.len() > 10);
    for entry in invalid {
        let request = &entry["request"];
        assert!(
            parse_request(request).is_none(),
            "accepted ({}): {request}",
            entry["why"]
        );
    }
}

#[test]
fn a_request_over_a_limit_is_refused() {
    let mut request = turn("run-1", "hi");
    request["input"] = json!("x".repeat(2 * 1024 * 1024 + 1));
    assert!(parse_request(&request).is_none());
    let mut request = turn("run-1", "hi");
    request["instructions"] = json!("x".repeat(512 * 1024 + 1));
    assert!(parse_request(&request).is_none());
    let mut request = turn("run-1", "hi");
    request["tools"] = json!(
        (0..257)
            .map(|n| json!({ "name": format!("t{n}"),
        "description": "", "inputSchema": {} }))
            .collect::<Vec<_>>()
    );
    assert!(parse_request(&request).is_none());
    let mut request = turn("run-1", "hi");
    request["botId"] = json!("b".repeat(257));
    assert!(parse_request(&request).is_none());
    let result = json!({ "method": "agentToolResult", "botId": "b", "runId": "r", "callId": "c",
        "text": "x".repeat(1024 * 1024 + 1), "isError": false });
    assert!(parse_request(&result).is_none());
}

#[test]
fn the_frame_checker_agrees_with_the_fixtures() {
    let fixtures: Value = serde_json::from_str(FRAMES).unwrap();
    for frame in fixtures["valid"].as_array().unwrap() {
        assert!(frame_ok(frame), "refused: {frame}");
    }
    for entry in fixtures["invalid"].as_array().unwrap() {
        assert!(
            !frame_ok(&entry["frame"]),
            "accepted ({}): {}",
            entry["why"],
            entry["frame"]
        );
    }
}

#[tokio::test]
async fn an_invalid_request_gets_one_error_and_no_agent_starts() {
    let bench = bench("reply", &[]);
    let fixtures: Value = serde_json::from_str(REQUESTS).unwrap();
    for entry in fixtures["invalid"].as_array().unwrap() {
        let request = entry["request"].clone();
        let answered = frames(&bench.runner, request).await;
        let all = values(&answered);
        assert!(all.is_empty(), "{answered:?}");
        assert_eq!(answered.len(), 1, "{}: {answered:?}", entry["why"]);
    }
    assert!(bench.log().is_empty());
    assert_eq!(bench.runner.agents().live(), 0);
}

#[tokio::test]
async fn an_agent_the_catalog_lacks_or_the_person_has_not_allowed_gets_an_error() {
    let bench = bench("reply", &[]);
    let mut request = turn("run-1", "hi");
    request["agent"] = json!("codex-agent");
    let answered = frames(&bench.runner, request).await;
    assert!(!error_of(&answered).is_empty());
    bench
        .runner
        .agents()
        .set_enabled("antigravity-agent", false);
    let answered = frames(&bench.runner, turn("run-2", "hi")).await;
    assert!(!error_of(&answered).is_empty());
    assert!(bench.log().is_empty());
}

#[tokio::test]
async fn the_catalog_can_be_replaced_for_a_fake_agent() {
    let bench = bench("reply", &[]);
    bench.runner.agents().set_catalog(OTHER);
    bench.runner.agents().set_enabled("fake-agent", true);
    let mut request = turn("run-1", "hi");
    request["agent"] = json!("fake-agent");
    let answered = frames(&bench.runner, request).await;
    assert_eq!(
        kinds(&answered),
        ["started", "activity", "text", "done"],
        "{answered:?}"
    );
    let args = std::fs::read_to_string(bench.dir.join("log.args")).unwrap();
    assert_eq!(args.lines().collect::<Vec<_>>(), ["acp", "extra"]);
    assert_eq!(bench.runner.agent_ids().await, ["fake-agent"]);
    let again = frames(&bench.runner, turn("run-3", "hi")).await;
    assert!(
        !error_of(&again).is_empty(),
        "the replaced catalog has no Antigravity"
    );
}

// ---------------------------------------------------------------------------------------------
// A turn.

#[tokio::test]
async fn a_turn_streams_started_activity_text_and_done() {
    let bench = bench("reply", &[]);
    let request = json!({ "method": "agentTurn", "botId": "bot-1", "runId": "run-1",
        "agent": "antigravity-agent", "model": "example-model-1.5", "instructions": "  Be kind.  ",
        "input": "hello", "tools": [] });
    let answered = frames(&bench.runner, request).await;
    assert_eq!(
        kinds(&answered),
        ["started", "activity", "text", "done"],
        "{answered:?}"
    );
    ends_with_done(&answered);
    let all = values(&answered);
    assert_eq!(all[1]["text"], "Reading notes");
    // The two chunks arrive as one text.
    assert_eq!(texts(&answered), ["Hello there"]);
    assert_eq!(
        bench.logged("prompt").unwrap(),
        json!("Instructions:\nBe kind.\n\nhello")
    );
    // The initialize request names the client's capabilities as the protocol asks.
    let init = bench.logged("initialize").unwrap();
    assert_eq!(init["protocolVersion"], 1);
    assert_eq!(
        init["clientCapabilities"]["fs"],
        json!({ "readTextFile": true, "writeTextFile": true })
    );
    assert_eq!(init["clientCapabilities"]["terminal"], false);
    // The model is never an argument, and the agent starts in the bot's own folder.
    let args = std::fs::read_to_string(bench.dir.join("log.args")).unwrap();
    assert_eq!(args.lines().collect::<Vec<_>>(), ["acp"]);
    let started = bench.logged("started").unwrap();
    let folder = bench.folder("bot-1");
    assert_eq!(
        Path::new(started["cwd"].as_str().unwrap()),
        folder.canonicalize().unwrap()
    );
    assert_eq!(
        bench.logged("new").unwrap()["cwd"],
        json!(folder.canonicalize().unwrap())
    );
    let mode = std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
    // Only what the allowlist passes, with the person's home and the login PATH.
    let env = started["env"].as_array().unwrap();
    assert!(
        !env.iter()
            .any(|name| name == "CARGO_HOME" || name == "RUSTUP_HOME"),
        "{env:?}"
    );
    assert_eq!(started["home"], json!(bench.dir.join("home")));
    assert!(
        started["path"]
            .as_str()
            .unwrap()
            .starts_with(&bin().display().to_string())
    );
    // Its tools reach the agent as an MCP server of this app's own program.
    let server = &bench.logged("new").unwrap()["mcpServers"][0];
    assert_eq!(server["name"], "dozo");
    assert_eq!(server["command"], json!(std::env::current_exe().unwrap()));
    assert_eq!(server["args"], json!(["--dozo-agent-bridge"]));
    let names: Vec<_> = server["env"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["DOZO_BRIDGE_SOCKET", "DOZO_BRIDGE_KEY"]);
    assert_eq!(bench.runner.agents().live(), 1);
}

#[tokio::test]
async fn text_is_joined_for_a_moment_and_split_at_sixteen_thousand_characters() {
    let bench = bench("chunks", &[]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    let all = texts(&answered);
    assert_eq!(all[0], "abc", "{all:?}");
    assert_eq!(all[1].chars().take(1).collect::<String>(), "d");
    assert!(all.iter().all(|text| text.chars().count() <= 16 * 1024));
    assert_eq!(
        all.iter().map(|t| t.chars().count()).sum::<usize>(),
        3 + 1 + 40_000
    );
    assert_eq!(kinds(&answered).last().unwrap(), "done");
}

#[tokio::test]
async fn an_agent_version_outside_the_range_ends_the_turn_and_its_process() {
    for scenario in ["old", "protocol"] {
        let bench = bench(scenario, &[]);
        let answered = frames(&bench.runner, turn("run-1", "go")).await;
        assert_eq!(kinds(&answered), ["failed"], "{answered:?}");
        assert_eq!(
            failed_message(&answered),
            "This Antigravity version has not been checked with Dozo yet."
        );
        ends_with_done(&answered);
        assert!(bench.logged("prompt").is_none());
        assert_eq!(bench.runner.agents().live(), 0);
    }
}

#[tokio::test]
async fn an_agent_that_is_signed_out_says_so() {
    let bench = bench("unauth", &[]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        failed_message(&answered),
        "Antigravity on this computer is not signed in. Sign in to it once in a terminal, then try again."
    );
    ends_with_done(&answered);
    assert_eq!(bench.runner.agents().live(), 0);
}

#[tokio::test]
async fn how_the_agent_ended_the_turn_decides_what_the_server_hears() {
    for (scenario, message) in [
        ("refusal", "Antigravity refused to go on."),
        ("cancelled", "Antigravity stopped the turn."),
        ("odd", "Antigravity ended the turn (weird)."),
    ] {
        let bench = bench(scenario, &[]);
        let answered = frames(&bench.runner, turn("run-1", "go")).await;
        assert_eq!(failed_message(&answered), message);
        ends_with_done(&answered);
        // The session stays for the next turn.
        assert_eq!(bench.runner.agents().live(), 1);
    }
}

// ---------------------------------------------------------------------------------------------
// Asking the person.

#[tokio::test]
async fn a_permission_the_person_allows_selects_allow_once_only() {
    let bench = bench("permission", &[Some(true)]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        kinds(&answered),
        ["started", "approvalWaiting", "text", "done"],
        "{answered:?}"
    );
    let waiting = &values(&answered)[1];
    assert_eq!(
        waiting["summary"],
        "Antigravity asks before it goes on (execute)."
    );
    assert_eq!(
        bench.logged("outcome").unwrap(),
        json!({ "outcome": "selected", "optionId": "once" })
    );
    let asked = bench.approvals.asked();
    assert_eq!(asked.len(), 1);
    assert!(
        asked[0].starts_with("Antigravity asks before it goes on (execute)."),
        "{}",
        asked[0]
    );
    assert!(
        asked[0].contains("Run ls")
            && asked[0].contains("/w/a")
            && asked[0].contains("\"command\":\"ls\"")
    );
    assert!(asked[0].chars().count() <= 2000);
}

#[tokio::test]
async fn a_permission_the_person_refuses_selects_reject_once_only() {
    let bench = bench("permission", &[Some(false)]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        kinds(&answered),
        ["started", "approvalWaiting", "text", "done"]
    );
    assert_eq!(
        bench.logged("outcome").unwrap(),
        json!({ "outcome": "selected", "optionId": "no" })
    );
}

#[tokio::test]
async fn without_a_one_time_option_the_request_is_cancelled_never_always() {
    for answer in [true, false] {
        let bench = bench("permission-no-once", &[Some(answer)]);
        frames(&bench.runner, turn("run-1", "go")).await;
        assert_eq!(
            bench.logged("outcome").unwrap(),
            json!({ "outcome": "cancelled" })
        );
    }
}

#[tokio::test]
async fn an_unanswered_permission_is_refused_after_the_wait_and_told_so() {
    let bench = bench("permission", &[None]);
    bench.runner.agents().set_timing(Timing {
        approval: Duration::from_millis(400),
        ..Timing::default()
    });
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        kinds(&answered),
        [
            "started",
            "approvalWaiting",
            "approvalExpired",
            "text",
            "done"
        ],
        "{answered:?}"
    );
    assert_eq!(
        values(&answered)[2]["summary"],
        "Antigravity asks before it goes on (execute)."
    );
    assert_eq!(
        bench.logged("outcome").unwrap(),
        json!({ "outcome": "selected", "optionId": "no" })
    );
    // A late answer does nothing.
    let held = bench.approvals.held.lock().unwrap().pop().unwrap();
    assert!(held.send(true).is_err());
    assert_eq!(
        bench
            .log()
            .iter()
            .filter(|e| e.get("outcome").is_some())
            .count(),
        1
    );
}

#[tokio::test]
async fn files_inside_the_bot_folder_are_read_without_asking() {
    let bench = bench("read-inside", &[]);
    let folder = bench.folder("bot-1");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("note.txt"), "one\ntwo\nthree\n").unwrap();
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        kinds(&answered),
        ["started", "text", "done"],
        "{answered:?}"
    );
    assert_eq!(
        bench.logged("read").unwrap()["result"],
        json!({ "content": "one\ntwo\nthree\n" })
    );
    assert!(bench.approvals.asked().is_empty());
}

#[tokio::test]
async fn a_read_can_take_a_line_and_a_limit() {
    let bench = bench("read-limit", &[]);
    let folder = bench.folder("bot-1");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("note.txt"), "one\ntwo\nthree\n").unwrap();
    frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        bench.logged("read").unwrap()["result"],
        json!({ "content": "two\n" })
    );
}

#[tokio::test]
async fn a_file_outside_the_bot_folder_is_asked_about_and_the_refusal_is_an_error() {
    for (answer, allowed) in [(true, true), (false, false)] {
        let bench = bench("read-outside", &[Some(answer)]);
        std::fs::create_dir_all(bench.folder("bot-1")).unwrap();
        let answered = frames(&bench.runner, turn("run-1", "go")).await;
        assert_eq!(
            kinds(&answered),
            ["started", "approvalWaiting", "text", "done"],
            "{answered:?}"
        );
        let asked = bench.approvals.asked();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].contains("secret.txt"), "{}", asked[0]);
        let read = bench.logged("read").unwrap();
        if allowed {
            assert_eq!(read["result"], json!({ "content": "top secret" }));
        } else {
            assert!(
                read["result"].is_null() && read["error"]["message"].is_string(),
                "{read}"
            );
        }
    }
}

#[tokio::test]
async fn a_symbolic_link_out_of_the_folder_counts_as_outside() {
    let bench = bench("read-link", &[Some(false)]);
    let folder = bench.folder("bot-1");
    std::fs::create_dir_all(&folder).unwrap();
    std::os::unix::fs::symlink(bench.dir.join("outside"), folder.join("link")).unwrap();
    frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        bench.approvals.asked().len(),
        1,
        "the link leads out, so it is asked"
    );
    assert!(bench.logged("read").unwrap()["error"].is_object());
}

#[tokio::test]
async fn writing_is_always_asked_about_even_inside_the_folder() {
    let bench = bench("write", &[Some(true)]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert!(
        kinds(&answered).contains(&"approvalWaiting".to_owned()),
        "{answered:?}"
    );
    assert_eq!(bench.approvals.asked().len(), 1);
    assert_eq!(
        std::fs::read_to_string(bench.folder("bot-1").join("out.txt")).unwrap(),
        "written"
    );
    let refused = self::bench("write", &[Some(false)]);
    frames(&refused.runner, turn("run-1", "go")).await;
    assert!(!refused.folder("bot-1").join("out.txt").exists());
    assert!(refused.logged("write").unwrap()["error"].is_object());
}

#[tokio::test]
async fn a_request_the_app_does_not_offer_is_answered_not_available() {
    let bench = bench("terminal", &[]);
    frames(&bench.runner, turn("run-1", "go")).await;
    let answer = bench.logged("terminal").unwrap();
    assert_eq!(
        answer["error"],
        json!({ "code": -32601, "message": "Dozo does not offer this." })
    );
}

#[tokio::test]
async fn reaching_outside_the_folder_without_asking_stops_the_turn() {
    let bench = bench("outside-tool", &[]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        failed_message(&answered),
        "Antigravity reached outside the bot's folder without asking, so the turn was stopped."
    );
    ends_with_done(&answered);
    assert_eq!(bench.runner.agents().live(), 0);
}

#[tokio::test]
async fn a_tool_outside_the_folder_the_person_approved_goes_on() {
    let bench = bench("outside-tool-approved", &[Some(true)]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        kinds(&answered),
        ["started", "activity", "approvalWaiting", "text", "done"],
        "{answered:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// The bridge to the bot's tools.

#[tokio::test]
async fn a_bot_tool_goes_out_as_a_frame_and_comes_back_as_a_result() {
    let bench = bench("bridge", &[]);
    let mut running = start(&bench.runner, with_tools(turn("run-1", "go")));
    let (_, call) = running.until("toolCall").await;
    assert_eq!(
        call,
        json!({ "type": "toolCall", "callId": "c1", "name": "memory_search",
        "args": { "query": "notes" } })
    );
    let result = json!({ "method": "agentToolResult", "botId": "bot-1", "runId": "run-1",
        "callId": "c1", "text": "Found 2 notes.", "isError": false });
    let delivered = frames(&bench.runner, result).await;
    assert_eq!(delivered, [json!({ "done": true })]);
    let rest = running.finish().await;
    assert_eq!(kinds(&rest), ["text", "done"], "{rest:?}");
    let list = bench.logged("list").unwrap();
    assert_eq!(
        list["tools"],
        json!([{ "name": "memory_search", "description": "Search.",
        "inputSchema": { "type": "object" } }])
    );
    assert_eq!(bench.logged("call").unwrap()["text"], "Found 2 notes.");
    assert_eq!(bench.logged("call").unwrap()["isError"], false);
    // A tool the turn did not list never reaches the server.
    assert_eq!(
        bench.logged("unknown").unwrap(),
        json!({ "id": 3, "text": "There is no tool named nope.", "isError": true })
    );
}

#[tokio::test]
async fn an_unknown_call_id_is_an_error() {
    let bench = bench("reply", &[]);
    let result = json!({ "method": "agentToolResult", "botId": "bot-1", "runId": "run-1",
        "callId": "c9", "text": "x", "isError": false });
    let answered = frames(&bench.runner, result).await;
    assert!(!error_of(&answered).is_empty());
}

#[tokio::test]
async fn a_wrong_key_ends_the_bridge_connection() {
    let bench = bench("badkey", &[]);
    frames(&bench.runner, with_tools(turn("run-1", "go"))).await;
    assert_eq!(bench.logged("badkey").unwrap(), Value::Null);
}

#[tokio::test]
async fn arguments_over_the_limit_are_an_error_and_send_no_frame() {
    let bench = bench("bigargs", &[]);
    let answered = frames(&bench.runner, with_tools(turn("run-1", "go"))).await;
    assert!(!kinds(&answered).contains(&"toolCall".to_owned()));
    assert_eq!(bench.logged("bigargs").unwrap()["isError"], true);
}

#[tokio::test]
async fn a_tool_waiting_when_the_turn_is_cancelled_is_answered_the_turn_ended() {
    let bench = bench("bridge", &[]);
    let mut running = start(&bench.runner, with_tools(turn("run-1", "go")));
    running.until("toolCall").await;
    running.cancel.send(CANCELLED).unwrap();
    running.finish().await;
    wait_for("the tool's answer", || bench.logged("call").is_some()).await;
    let call = bench.logged("call").unwrap();
    assert_eq!(call["text"], "The turn ended.");
    assert_eq!(call["isError"], true);
}

// ---------------------------------------------------------------------------------------------
// A session's life.

#[tokio::test]
async fn a_second_turn_of_the_run_goes_on_in_the_same_session() {
    let bench = bench("hang-once", &[]);
    let mut first = start(&bench.runner, turn("run-1", "one"));
    first.until("started").await;
    // Busy: a turn is running.
    let busy = frames(&bench.runner, turn("run-1", "two")).await;
    assert!(error_of(&busy).to_lowercase().contains("busy"), "{busy:?}");
    first.cancel.send(CANCELLED).unwrap();
    first.finish().await;
    assert!(bench.logged("cancel").is_some());
    assert_eq!(bench.runner.agents().live(), 1, "the session stays");
    let answered = frames(&bench.runner, turn("run-1", "two")).await;
    assert_eq!(texts(&answered), ["ok"], "{answered:?}");
    // One process, one session: the agent saw `session/new` once, and the second prompt carried
    // the person's words alone.
    let prompts: Vec<_> = bench
        .log()
        .iter()
        .filter_map(|e| e.get("prompt").cloned())
        .collect();
    assert_eq!(
        prompts,
        [json!("Instructions:\nBe kind.\n\none"), json!("two")]
    );
    assert_eq!(
        bench
            .log()
            .iter()
            .filter(|e| e.get("new").is_some())
            .count(),
        1
    );
}

#[tokio::test]
async fn a_lost_connection_cancels_the_same_way() {
    let bench = bench("hang-once", &[]);
    let mut first = start(&bench.runner, turn("run-1", "one"));
    first.until("started").await;
    first.cancel.send(LOST).unwrap();
    first.finish().await;
    assert!(bench.logged("cancel").is_some());
    assert_eq!(bench.runner.agents().live(), 1);
}

#[tokio::test]
async fn a_run_seen_before_that_has_no_session_is_interrupted() {
    let bench = bench("reply", &[]);
    frames(&bench.runner, turn("run-1", "go")).await;
    // The app restarted: a new runner over the same folder has the run on record, not the session.
    let again = Runner::new(bench.dir.join("data"), bench.dir.join("home"));
    again.agents().set_catalog(VERIFIED);
    again
        .agents()
        .set_path(format!("{}:/usr/bin:/bin", bin().display()));
    again.agents().set_enabled("antigravity-agent", true);
    let answered = frames(&again, turn("run-1", "again")).await;
    assert_eq!(kinds(&answered), ["failed"]);
    assert_eq!(
        failed_message(&answered),
        "The agent was interrupted: its process ended before this turn finished. Send the message again."
    );
    ends_with_done(&answered);
    // A new run is fine.
    let fresh = frames(&again, turn("run-2", "go")).await;
    assert_eq!(kinds(&fresh).last().unwrap(), "done");
    assert_eq!(failed_count(&fresh), 0);
}

fn failed_count(frames: &[Value]) -> usize {
    kinds(frames)
        .iter()
        .filter(|kind| *kind == "failed")
        .count()
}

#[test]
fn the_runs_seen_are_kept_seven_days_and_ten_thousand_lines() {
    let dir = std::env::temp_dir().join(format!("dozo-seen-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut lines = vec![format!("{} old-run", now - 8 * 24 * 3600)];
    lines.extend((0..10_050).map(|n| format!("{now} run-{n}")));
    std::fs::write(dir.join("seen"), lines.join("\n") + "\n").unwrap();
    let agents = Agents::new(dir.clone());
    assert!(!agents.has_seen("old-run"));
    assert!(!agents.has_seen("run-0"));
    assert!(agents.has_seen("run-10049"));
    assert!(agents.has_seen("run-50"));
    assert_eq!(agents.seen_count(), 10_000);
}

#[tokio::test]
async fn stopping_the_run_ends_the_process_group_and_the_bridge_but_not_the_folder() {
    let bench = bench("child", &[]);
    frames(&bench.runner, with_tools(turn("run-1", "go"))).await;
    let child = bench.logged("child").unwrap().as_u64().unwrap();
    assert!(!gone(child));
    let socket = PathBuf::from(
        bench.logged("new").unwrap()["mcpServers"][0]["env"][0]["value"]
            .as_str()
            .unwrap(),
    );
    assert!(socket.exists());
    let stop = json!({ "method": "agentStop", "botId": "bot-1", "runId": "run-1" });
    let answered = frames(&bench.runner, stop).await;
    assert_eq!(answered, [json!({ "done": true })]);
    wait_for("the child to end", || gone(child)).await;
    assert!(!socket.exists());
    assert!(!socket.parent().unwrap().exists());
    assert_eq!(bench.runner.agents().live(), 0);
    assert!(bench.folder("bot-1").is_dir());
    // Stopping what is not there is fine.
    let again = json!({ "method": "agentStop", "botId": "bot-1", "runId": "run-1" });
    assert_eq!(
        frames(&bench.runner, again).await,
        [json!({ "done": true })]
    );
}

#[tokio::test]
async fn at_most_four_sessions_live_and_a_fifth_is_refused_at_once() {
    let bench = bench("hang", &[]);
    let mut running = Vec::new();
    for n in 0..4 {
        let mut one = start(&bench.runner, turn(&format!("run-{n}"), "go"));
        one.until("started").await;
        running.push(one);
    }
    let fifth = frames(&bench.runner, turn("run-5", "go")).await;
    assert!(
        error_of(&fifth).to_lowercase().contains("busy"),
        "{fifth:?}"
    );
    assert_eq!(bench.runner.agents().live(), 4);
    for one in &running {
        one.cancel.send(CANCELLED).unwrap();
    }
    for one in running {
        one.finish().await;
    }
}

#[tokio::test]
async fn a_session_without_a_turn_closes_after_the_idle_time() {
    let bench = bench("reply", &[]);
    bench.runner.agents().set_timing(Timing {
        idle: Duration::from_millis(500),
        ..Timing::default()
    });
    frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(bench.runner.agents().live(), 1);
    wait_for("the idle close", || bench.runner.agents().live() == 0).await;
}

#[tokio::test]
async fn turning_an_agent_off_closes_its_sessions() {
    let bench = bench("reply", &[]);
    frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(bench.runner.agents().live(), 1);
    bench
        .runner
        .agents()
        .set_enabled("antigravity-agent", false);
    assert_eq!(bench.runner.agents().live(), 0);
    assert!(bench.runner.agent_ids().await.is_empty());
}

#[tokio::test]
async fn stopping_everything_ends_the_sessions() {
    let bench = bench("reply", &[]);
    frames(&bench.runner, turn("run-1", "go")).await;
    bench.runner.stop_all(true);
    assert_eq!(bench.runner.agents().live(), 0);
}

// ---------------------------------------------------------------------------------------------
// Offering an agent.

#[tokio::test]
async fn an_agent_is_offered_only_when_allowed_and_found() {
    let bench = bench("reply", &[]);
    let agents = bench.runner.agents();
    assert_eq!(agents.offered().await, ["antigravity-agent"]);
    agents.set_enabled("antigravity-agent", false);
    assert!(agents.offered().await.is_empty());
    agents.set_enabled("antigravity-agent", true);
    agents.set_path(format!("{}:/usr/bin", bench.dir.join("nothing").display()));
    assert!(agents.offered().await.is_empty());
}

#[test]
fn what_the_person_allowed_is_kept_in_agents_json() {
    let dir = std::env::temp_dir().join(format!("dozo-agents-json-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("agents.json");
    let agents = Agents::new(dir.join("agents"));
    agents.set_config(file.clone());
    assert!(!agents.enabled("antigravity-agent"));
    agents.set_enabled("antigravity-agent", true);
    let saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved, json!({ "enabled": ["antigravity-agent"] }));
    let later = Agents::new(dir.join("agents"));
    later.set_config(file.clone());
    assert!(later.enabled("antigravity-agent"));
    later.set_enabled("antigravity-agent", false);
    let saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved, json!({ "enabled": [] }));
    // A file that is not ours allows nothing.
    std::fs::write(&file, "{ not json").unwrap();
    let broken = Agents::new(dir.join("agents"));
    broken.set_config(file);
    assert!(!broken.enabled("antigravity-agent"));
}

#[test]
fn the_words_of_the_switch_and_its_consent() {
    let entry = &CATALOG[0];
    let english = words(entry, false);
    assert_eq!(english.menu, "Let Bots Use Antigravity Here");
    assert_eq!(english.allow, "Allow");
    assert_eq!(english.cancel, "Cancel");
    assert_eq!(
        english.consent,
        "A bot can run Antigravity on this computer with your Antigravity account. Antigravity asks you here before it writes, runs a program or reaches outside the bot's folder. Google may close accounts used outside its own products."
    );
    let turkish = words(entry, true);
    assert_eq!(turkish.menu, "Botlar Burada Antigravity Kullansın");
    assert_eq!(turkish.allow, "İzin Ver");
    assert_eq!(turkish.cancel, "İptal");
    assert_eq!(
        turkish.consent,
        "Bir bot bu bilgisayarda Antigravity'yi Antigravity hesabınızla çalıştırabilir. Antigravity yazmadan, program çalıştırmadan ya da botun klasörü dışına çıkmadan önce burada sorar. Google, kendi ürünleri dışında kullanılan hesapları kapatabilir."
    );
}

#[test]
fn the_catalog_names_antigravity() {
    assert_eq!(CATALOG.len(), 1);
    let entry = &CATALOG[0];
    assert_eq!(
        (entry.id, entry.name, entry.command),
        ("antigravity-agent", "Antigravity", "agy")
    );
    assert_eq!(entry.args, ["acp"]);
    assert_eq!((entry.min, entry.below), ([1, 5, 0], [1, 6, 0]));
    assert!(entry.terms.is_some());
    assert_eq!(bot_key("x").len(), 64);
}

#[tokio::test]
async fn stopping_a_bot_closes_its_sessions_and_leaves_the_others() {
    let bench = bench("reply", &[]);
    frames(&bench.runner, turn("run-1", "go")).await;
    let mut other = turn("run-2", "go");
    other["botId"] = json!("bot-2");
    frames(&bench.runner, other).await;
    assert_eq!(bench.runner.agents().live(), 2);
    frames(&bench.runner, json!({ "method": "stop", "botId": "bot-1" })).await;
    assert_eq!(bench.runner.agents().live(), 1);
}

/// The connection tells the server which agents are offered, in the capabilities header.
#[tokio::test]
async fn the_connection_declares_each_allowed_installed_agent() {
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    let bench = bench("reply", &[]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = tauri::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let (declared, heard) = oneshot::channel();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let declared = Mutex::new(Some(declared));
        #[allow(clippy::result_large_err)] // The handshake callback's signature is tungstenite's.
        let check = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
            let header = request.headers().get("x-dozo-device-capabilities").unwrap();
            let _ = declared
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send(header.to_str().unwrap().to_owned());
            Ok(response)
        };
        let _socket = tokio_tungstenite::accept_hdr_async(stream, check)
            .await
            .unwrap();
        std::future::pending::<()>().await;
    });
    let (stop, stopped) = watch::channel(false);
    let options = crate::device_socket::Options {
        server,
        token: "good".to_owned(),
        runner: bench.runner.clone(),
        retry: (Duration::from_millis(20), Duration::from_millis(40)),
        grace: Duration::from_millis(300),
    };
    let connection = tokio::spawn(crate::device_socket::run(options, stopped));
    let declared = tokio::time::timeout(Duration::from_secs(10), heard)
        .await
        .unwrap()
        .unwrap();
    assert!(declared.starts_with("shell"), "{declared}");
    assert!(declared.ends_with(",agent:antigravity-agent"), "{declared}");
    stop.send(true).unwrap();
    let _ = connection.await;
}

#[tokio::test]
async fn a_running_turn_sends_a_heartbeat() {
    let bench = bench("hang", &[]);
    bench.runner.agents().set_timing(Timing {
        heartbeat: Duration::from_millis(200),
        ..Timing::default()
    });
    let mut running = start(&bench.runner, turn("run-1", "go"));
    running.until("started").await;
    let beat = tokio::time::timeout(Duration::from_secs(10), running.frames.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(decode(&beat), json!({ "heartbeat": true }));
    running.cancel.send(CANCELLED).unwrap();
    running.finish().await;
}

#[tokio::test]
async fn a_cancelled_turn_answers_the_waiting_permission_cancelled_and_the_session_stays() {
    let bench = bench("permission", &[None]);
    let mut running = start(&bench.runner, turn("run-1", "go"));
    running.until("approvalWaiting").await;
    running.cancel.send(CANCELLED).unwrap();
    running.finish().await;
    assert_eq!(
        bench.logged("outcome").unwrap(),
        json!({ "outcome": "cancelled" })
    );
    assert!(bench.logged("cancel").is_some());
    assert_eq!(bench.runner.agents().live(), 1);
}

// ---------------------------------------------------------------------------------------------
// The review's findings.

#[tokio::test]
async fn a_write_through_a_dangling_link_counts_as_its_target_outside() {
    let bench = bench("write-link", &[Some(true)]);
    let folder = bench.folder("bot-1");
    std::fs::create_dir_all(&folder).unwrap();
    let target = bench.dir.join("outside/new.txt");
    std::os::unix::fs::symlink(&target, folder.join("dang")).unwrap();
    frames(&bench.runner, turn("run-1", "go")).await;
    let asked = bench.approvals.asked();
    assert_eq!(asked.len(), 1);
    assert!(asked[0].contains("outside/new.txt"), "{}", asked[0]);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "written");
    assert!(folder.join("dang").symlink_metadata().unwrap().is_symlink());
}

#[tokio::test]
async fn a_path_that_became_a_link_after_the_answer_is_refused() {
    let bench = bench("write-race", &[Some(true)]);
    let folder = bench.folder("bot-1");
    std::fs::create_dir_all(&folder).unwrap();
    let (link, secret) = (folder.join("out.txt"), bench.dir.join("outside/secret.txt"));
    *bench.approvals.before.lock().unwrap() = Some(Box::new(move || {
        std::os::unix::fs::symlink(&secret, &link).unwrap();
    }));
    frames(&bench.runner, turn("run-1", "go")).await;
    assert!(bench.logged("write").unwrap()["error"].is_object());
    assert_eq!(
        std::fs::read_to_string(bench.dir.join("outside/secret.txt")).unwrap(),
        "top secret"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pipe_is_not_read_and_nothing_blocks() {
    let bench = bench("read-fifo", &[]);
    let folder = bench.folder("bot-1");
    std::fs::create_dir_all(&folder).unwrap();
    let pipe = std::ffi::CString::new(folder.join("pipe").to_str().unwrap()).unwrap();
    // SAFETY: a plain mkfifo(3) on a path made above.
    assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(kinds(&answered).last().unwrap(), "done");
    assert!(bench.logged("read").unwrap()["error"].is_object());
}

#[tokio::test]
async fn only_one_question_is_open_at_a_time() {
    let bench = bench("permission-twice", &[None]);
    bench.runner.agents().set_timing(Timing {
        approval: Duration::from_millis(300),
        ..Timing::default()
    });
    frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(bench.approvals.asked().len(), 1);
    let twice = bench.logged("twice").unwrap();
    let outcome = |id: u64| {
        twice
            .as_array()
            .unwrap()
            .iter()
            .find(|pair| pair[0] == id)
            .unwrap()[1]
            .clone()
    };
    assert_eq!(
        outcome(801),
        json!({ "outcome": "selected", "optionId": "no" })
    );
    assert_eq!(outcome(802), json!({ "outcome": "cancelled" }));
}

#[test]
fn lengths_are_counted_the_way_the_protocol_counts_them() {
    assert_eq!(cut("😀😀😀", 4), "😀😀");
    assert_eq!(cut("a😀", 2), "a");
    assert_eq!(cut("abc", 10), "abc");
}

#[tokio::test]
async fn a_second_request_for_a_run_that_is_starting_is_busy() {
    let bench = bench("slow-new", &[]);
    let first = start(&bench.runner, turn("run-1", "go"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let second = frames(&bench.runner, turn("run-1", "again")).await;
    assert!(
        error_of(&second).to_lowercase().contains("busy"),
        "{second:?}"
    );
    let rest = first.finish().await;
    assert_eq!(kinds(&rest).last().unwrap(), "done", "{rest:?}");
}

#[tokio::test]
async fn sessions_that_are_starting_count_toward_the_four() {
    let bench = bench("slow-new", &[]);
    let started: Vec<_> = (0..4)
        .map(|n| start(&bench.runner, turn(&format!("run-{n}"), "go")))
        .collect();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let fifth = frames(&bench.runner, turn("run-9", "go")).await;
    assert!(
        error_of(&fifth).to_lowercase().contains("busy"),
        "{fifth:?}"
    );
    for one in started {
        one.finish().await;
    }
    assert_eq!(bench.runner.agents().live(), 4);
}

#[tokio::test]
async fn a_start_that_fails_does_not_mark_the_run_as_seen() {
    let bench = bench("unauth", &[]);
    for _ in 0..2 {
        let answered = frames(&bench.runner, turn("run-1", "go")).await;
        assert!(
            failed_message(&answered).contains("not signed in"),
            "{answered:?}"
        );
    }
    assert!(!bench.runner.agents().has_seen("run-1"));
}

#[tokio::test]
async fn reaching_outside_closes_the_session_without_waiting_for_the_agent() {
    let bench = bench("outside-tool-deaf", &[]);
    let started = std::time::Instant::now();
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert!(failed_message(&answered).contains("reached outside"));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(bench.runner.agents().live(), 0);
}

#[tokio::test]
async fn no_prompt_goes_to_the_agent_after_the_call_was_cancelled() {
    let bench = bench("reply", &[]);
    frames(&bench.runner, turn("run-1", "one")).await;
    let (reply, call) = reply("late");
    call.cancel.send(CANCELLED).unwrap();
    bench.runner.handle(&turn("run-1", "two"), &reply).await;
    let prompts = bench
        .log()
        .iter()
        .filter(|e| e.get("prompt").is_some())
        .count();
    assert_eq!(prompts, 1);
    assert_eq!(bench.runner.agents().live(), 1);
}

#[tokio::test]
async fn a_line_over_the_limit_from_the_agent_closes_the_session() {
    let bench = bench("bigline", &[]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        kinds(&answered).last().unwrap(),
        "failed",
        "{:?}",
        kinds(&answered)
    );
    assert_eq!(bench.runner.agents().live(), 0);
}

#[tokio::test]
async fn a_flood_of_chunks_arrives_whole() {
    let bench = bench("flood", &[]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    let all: usize = texts(&answered).iter().map(|t| t.chars().count()).sum();
    assert_eq!(all, 2000);
    assert_eq!(kinds(&answered).last().unwrap(), "done");
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_the_session_ends_a_bridge_connection_that_is_open() {
    use std::io::Read;
    let bench = bench("reply", &[]);
    frames(&bench.runner, turn("run-1", "go")).await;
    let session = bench
        .runner
        .agents()
        .0
        .sessions
        .lock()
        .unwrap()
        .values()
        .next()
        .cloned()
        .unwrap();
    let mut socket = std::os::unix::net::UnixStream::connect(session.bridge_dir.join("s")).unwrap();
    writeln!(
        socket,
        "{}",
        json!({ "id": 1, "key": session.bridge_key, "method": "list" })
    )
    .unwrap();
    let mut first = [0u8; 1];
    socket.read_exact(&mut first).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    session.close();
    let mut rest = Vec::new();
    // The rest of the answer, then the end of the connection: not a wait that times out.
    let ended = socket.read_to_end(&mut rest);
    assert!(ended.is_ok(), "{ended:?}");
}

#[tokio::test]
async fn a_folder_that_is_not_utf8_ends_the_start_with_an_error() {
    use std::os::unix::ffi::OsStrExt;
    let bench = bench("reply", &[]);
    let odd = std::ffi::OsStr::from_bytes(b"d\xffata");
    let runner = Runner::new(bench.dir.join(odd), bench.dir.join("home"));
    runner.agents().set_catalog(VERIFIED);
    runner
        .agents()
        .set_path(format!("{}:/usr/bin:/bin", bin().display()));
    runner.agents().set_enabled("antigravity-agent", true);
    let answered = frames(&runner, turn("run-1", "go")).await;
    assert_eq!(kinds(&answered), ["failed"], "{answered:?}");
    assert_eq!(runner.agents().live(), 0);
}

#[test]
fn no_key_is_made_when_the_system_has_no_randomness() {
    assert!(hex_from(32, |_| false).is_none());
    let key = hex_from(2, |bytes| {
        bytes.copy_from_slice(&[1, 255]);
        true
    });
    assert_eq!(key.as_deref(), Some("01ff"));
}

#[test]
fn a_capability_word_the_header_cannot_carry_leaves_the_plain_header() {
    use crate::device_socket::capabilities_header;
    assert_eq!(
        capabilities_header(true, true, false, &["a-b"]),
        "shell,browser,agent:a-b"
    );
    assert_eq!(
        capabilities_header(true, true, false, &["bad\nid"]),
        "shell,browser"
    );
}

// ---------------------------------------------------------------------------------------------
// The security review's findings.

fn pieces(title: &str, input: Value) -> Option<String> {
    dialog_text(
        "Antigravity asks before it goes on (execute).",
        Some(title),
        &["/w/a".to_owned()],
        Some(&input),
    )
}

#[test]
fn a_question_that_fits_is_shown_as_it_is_and_one_that_does_not_is_not_shown() {
    let text = pieces("Run ls", json!({ "command": "ls" })).unwrap();
    assert!(text.starts_with("Antigravity asks before it goes on (execute)."));
    assert!(
        text.contains("Run ls") && text.contains("/w/a") && text.contains("{\"command\":\"ls\"}")
    );
    assert!(!text.contains('…'));
    assert!(text.chars().count() <= 2000);
    assert!(pieces("Run ls", json!({ "command": "x".repeat(5000) })).is_none());
    assert!(pieces(&"t".repeat(400), json!({})).is_none());
    let long_path = dialog_text("head", None, &["p".repeat(700)], None);
    assert!(long_path.is_none());
}

#[test]
fn a_question_with_a_control_or_direction_character_is_not_shown() {
    for bad in [
        "\n", "\r", "\t", "\u{0}", "\u{85}", "\u{2028}", "\u{2029}", "\u{202A}", "\u{202B}",
        "\u{202C}", "\u{202D}", "\u{202E}", "\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}",
        "\u{200E}", "\u{200F}", "\u{61C}",
    ] {
        let text = format!("a{bad}b");
        assert!(pieces(&text, json!({})).is_none(), "title {bad:?}");
        assert!(
            dialog_text("h", None, std::slice::from_ref(&text), None).is_none(),
            "path {bad:?}"
        );
        assert!(
            pieces("t", json!({ "command": text.clone() })).is_none(),
            "input {bad:?}"
        );
        assert!(
            pieces("t", json!([{ text.clone(): 1 }])).is_none(),
            "key {bad:?}"
        );
    }
    assert!(pieces("Run ls ünï 😀", json!({ "command": "ls" })).is_some());
}

#[tokio::test]
async fn a_command_too_long_to_show_is_refused_without_asking() {
    let bench = bench("permission-long", &[Some(true)]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert!(bench.approvals.asked().is_empty());
    assert_eq!(
        bench.logged("outcome").unwrap(),
        json!({ "outcome": "selected", "optionId": "no" })
    );
    assert_eq!(
        kinds(&answered),
        ["started", "activity", "text", "done"],
        "{answered:?}"
    );
    assert_eq!(
        values(&answered)[1]["text"],
        "This request could not be shown safely, so it was refused."
    );
}

#[tokio::test]
async fn a_command_with_a_direction_or_line_character_is_refused_without_asking() {
    for scenario in ["permission-bidi", "permission-newline"] {
        let bench = bench(scenario, &[Some(true)]);
        frames(&bench.runner, turn("run-1", "go")).await;
        assert!(bench.approvals.asked().is_empty(), "{scenario}");
        assert_eq!(
            bench.logged("outcome").unwrap(),
            json!({ "outcome": "selected", "optionId": "no" })
        );
    }
}

#[tokio::test]
async fn a_file_name_with_a_line_break_is_refused_without_asking() {
    let bench = bench("write-newline-path", &[Some(true)]);
    std::fs::create_dir_all(bench.folder("bot-1")).unwrap();
    frames(&bench.runner, turn("run-1", "go")).await;
    assert!(bench.approvals.asked().is_empty());
    let answer = bench.logged("write").unwrap();
    assert_eq!(
        answer["error"]["message"],
        "This request could not be shown safely, so it was refused."
    );
}

#[test]
fn an_agent_not_yet_verified_is_never_offered() {
    let entry = &CATALOG[0];
    assert!(
        !entry.verified,
        "Antigravity has not been checked with a real agent yet"
    );
}

#[tokio::test]
async fn an_unverified_entry_is_neither_declared_nor_driven_nor_in_the_menu() {
    let bench = bench("reply", &[]);
    // The real catalog, whose entry is not verified.
    let runner = Runner::new(bench.dir.join("data2"), bench.dir.join("home"));
    runner
        .agents()
        .set_path(format!("{}:/usr/bin:/bin", bin().display()));
    runner.agents().set_enabled("antigravity-agent", true);
    assert!(runner.agents().enabled("antigravity-agent"));
    assert!(runner.agents().offered().await.is_empty());
    assert!(runner.agents().found().await.is_empty());
    let answered = frames(&runner, turn("run-1", "go")).await;
    assert!(!error_of(&answered).is_empty());
    assert!(bench.log().is_empty());
    // The same entry, verified, is offered.
    assert_eq!(bench.runner.agents().offered().await, ["antigravity-agent"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_whose_folder_became_a_link_after_the_answer_is_not_read() {
    let bench = bench("read-race", &[Some(true)]);
    std::fs::create_dir_all(bench.folder("bot-1")).unwrap();
    let outside = bench.dir.join("outside");
    std::fs::create_dir_all(outside.join("sub")).unwrap();
    std::fs::create_dir_all(outside.join("other")).unwrap();
    std::fs::write(outside.join("sub/secret.txt"), "the one shown").unwrap();
    std::fs::write(outside.join("other/secret.txt"), "another one").unwrap();
    *bench.approvals.before.lock().unwrap() = Some(Box::new(move || {
        std::fs::rename(outside.join("sub"), outside.join("sub-old")).unwrap();
        std::os::unix::fs::symlink(outside.join("other"), outside.join("sub")).unwrap();
    }));
    frames(&bench.runner, turn("run-1", "go")).await;
    let read = bench.logged("read").unwrap();
    assert!(read["error"].is_object(), "{read}");
    assert!(read["result"].is_null());
}

#[tokio::test]
async fn the_fourth_refused_question_of_a_turn_ends_the_turn() {
    let bench = bench(
        "permission-many",
        &[
            Some(false),
            Some(false),
            Some(false),
            Some(false),
            Some(false),
        ],
    );
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        failed_message(&answered),
        "Antigravity asked too many questions that were refused, so the turn was stopped."
    );
    ends_with_done(&answered);
    assert_eq!(bench.approvals.asked().len(), 4);
    assert_eq!(bench.runner.agents().live(), 0);
}

#[tokio::test]
async fn the_messages_carry_the_name_of_the_agent_they_are_about() {
    for (scenario, message) in [
        (
            "unauth",
            "Fake on this computer is not signed in. Sign in to it once in a terminal, then try again.",
        ),
        (
            "old",
            "This Fake version has not been checked with Dozo yet.",
        ),
        (
            "outside-tool",
            "Fake reached outside the bot's folder without asking, so the turn was stopped.",
        ),
    ] {
        let bench = bench(scenario, &[]);
        bench.runner.agents().set_catalog(OTHER);
        bench.runner.agents().set_enabled("fake-agent", true);
        let mut request = turn("run-1", "go");
        request["agent"] = json!("fake-agent");
        let answered = frames(&bench.runner, request).await;
        assert_eq!(failed_message(&answered), message, "{scenario}");
    }
}

#[test]
fn only_absolute_folders_of_the_path_are_searched() {
    let absolute = bin().to_str().unwrap().to_owned();
    // The same folder, written relative to where the tests run.
    let here = std::env::current_dir().unwrap();
    let up = "../".repeat(here.components().count() - 1);
    let relative = format!("{up}{}", absolute.trim_start_matches('/'));
    assert!(
        std::path::Path::new(&here)
            .join(&relative)
            .join("agy")
            .exists()
    );
    assert!(find_on_path("agy", &absolute).is_some());
    assert!(find_on_path("agy", &relative).is_none());
    assert!(find_on_path("agy", &format!(".:{relative}:{absolute}")).is_some());
}

#[tokio::test]
async fn a_bot_folder_that_is_a_link_out_of_the_app_data_starts_nothing() {
    for (case, linked) in [("folder", false), ("parent", true)] {
        let bench = bench("reply", &[]);
        let data = bench.dir.join("data");
        let elsewhere = bench.dir.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let key = bot_key("bot-1");
        if linked {
            std::fs::create_dir_all(&data).unwrap();
            std::os::unix::fs::symlink(&elsewhere, data.join("desktop-computers")).unwrap();
        } else {
            std::fs::create_dir_all(data.join("desktop-computers")).unwrap();
            std::os::unix::fs::symlink(&elsewhere, data.join("desktop-computers").join(&key))
                .unwrap();
        }
        let answered = frames(&bench.runner, turn("run-1", "go")).await;
        assert_eq!(kinds(&answered), ["failed"], "{case}: {answered:?}");
        assert!(bench.log().is_empty(), "{case}: no agent was started");
        assert_eq!(bench.runner.agents().live(), 0);
        // Nothing was made on the far side of the link.
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0, "{case}");
    }
}

#[test]
fn invisible_and_format_characters_are_not_shown() {
    let mut bad: Vec<char> = Vec::new();
    for range in [
        0xAD..=0xAD,
        0x61C..=0x61C,
        0x180E..=0x180E,
        0x200B..=0x200F,
        0x202A..=0x202E,
        0x2060..=0x2064,
        0x2066..=0x206F,
        0xFEFF..=0xFEFF,
        0xFFF9..=0xFFFB,
        0xE0000..=0xE007F,
        0x115F..=0x115F,
        0x1160..=0x1160,
        0x3164..=0x3164,
        0xFFA0..=0xFFA0,
        0x2800..=0x2800,
    ] {
        bad.extend(range.filter_map(char::from_u32));
    }
    for character in bad {
        let text = format!("a{character}b");
        assert!(unsafe_char(character), "U+{:04X}", character as u32);
        assert!(
            pieces(&text, json!({})).is_none(),
            "title U+{:04X}",
            character as u32
        );
        assert!(
            dialog_text("h", None, std::slice::from_ref(&text), None).is_none(),
            "path U+{:04X}",
            character as u32
        );
    }
    // Ordinary text of other scripts stays.
    assert!(pieces("Çalıştır ünï 日本語 😀", json!({ "command": "ls" })).is_some());
}

#[test]
fn a_long_run_of_blanks_is_not_shown() {
    let run = |count: usize, blank: char| format!("a{}b", blank.to_string().repeat(count));
    for blank in [
        ' ', '\u{A0}', '\u{1680}', '\u{2003}', '\u{202F}', '\u{205F}', '\u{3000}',
    ] {
        assert!(pieces(&run(4, blank), json!({})).is_some(), "{blank:?} x4");
        assert!(pieces(&run(5, blank), json!({})).is_none(), "{blank:?} x5");
    }
    // Different blanks together count as one run.
    assert!(pieces("a  \u{A0}\u{3000} b", json!({})).is_none());
    // Spread out, they are fine; in a path or a command too.
    assert!(pieces("a  b  c  d", json!({})).is_some());
    assert!(dialog_text("h", None, &[format!("/w/{}x", " ".repeat(5))], None).is_none());
    assert!(pieces("t", json!({ "command": format!("ls{}-l", " ".repeat(5)) })).is_none());
}

#[tokio::test]
async fn busy_questions_count_toward_the_refusals_of_a_turn() {
    let bench = bench("permission-flood", &[None]);
    let answered = frames(&bench.runner, turn("run-1", "go")).await;
    assert_eq!(
        failed_message(&answered),
        "Antigravity asked too many questions that were refused, so the turn was stopped."
    );
    assert_eq!(bench.approvals.asked().len(), 1);
    assert_eq!(bench.runner.agents().live(), 0);
}

#[test]
fn every_answer_but_a_yes_counts_as_a_refusal() {
    assert!(!counts_as_refusal(&Decision::Allow));
    for decision in [
        Decision::Deny,
        Decision::Expired,
        Decision::Cancelled,
        Decision::Busy,
        Decision::Refused,
    ] {
        assert!(counts_as_refusal(&decision));
    }
}
