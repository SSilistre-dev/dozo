//! An agent CLI on this computer (Antigravity, over ACP, the Agent Client Protocol) runs a bot's
//! turn when the server asks for one over the device connection. The wire is
//! `packages/adapters/src/dozo-agent-device-protocol.ts`; the behaviour follows the server's own
//! driver for the same agent (`cli-models/acp/dozo-acp-agent.ts`). Unix only: elsewhere the three
//! methods answer "Not available on this computer" (`device_run.rs`).
//!
//! What the server may say is only which agent of the catalog below, and what a turn needs: the
//! bot's instructions and conversation, its tools and their results. It never names a program, an
//! argument, a folder or an answer to the agent's own questions. Those stay here:
//! - the agent is started without a shell, in its own process group, in the bot's own folder, with
//!   the allowed part of this app's environment, the person's home and their login shell's `PATH`;
//! - what the agent asks before it goes on (`session/request_permission`), reading outside the
//!   bot's folder and every write through the client's file methods are asked of the person in a
//!   dialog of this app, and the server only hears that the app is waiting;
//! - the bot's tools reach the agent as an MCP server that is this app's own program
//!   (`agent_bridge.rs`), over a Unix socket in a private folder and with a key made for the run.
//!
//! One process per run (bot and run id), at most four at once, closed after half an hour without
//! a turn, by `agentStop`, when the person turns the agent off or when access ends.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{Instant, MissedTickBehavior, interval, sleep, sleep_until, timeout};

use crate::device_run::{
    BUSY, INVALID, MARK_VAR, NOT_HERE, Reply, Runner, bot_key, cancelled, environment, kill,
    new_mark, own_group,
};

/// An agent this app can drive, fixed here: the server only names one by `id`. `terms`: what its
/// maker's terms put at risk, said once when the person lets bots use it.
pub struct Entry {
    pub id: &'static str,
    pub name: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    /// The agent versions this was checked with: at least `min`, below `below`.
    pub min: [u32; 3],
    pub below: [u32; 3],
    pub terms: Option<Terms>,
    /// Whether this agent was checked with this app against the real thing. Until it was, it is
    /// not offered to the server, not driven and not in the menu.
    pub verified: bool,
}

pub struct Terms {
    pub en: &'static str,
    pub tr: &'static str,
}

/// Antigravity's CLI was seen at 1.5.13 (its ACP `initialize`); the range is the one the
/// server's own catalog holds (`cli-models/acp/dozo-acp-catalog.ts`).
pub const CATALOG: &[Entry] = &[Entry {
    id: "antigravity-agent",
    name: "Antigravity",
    command: "agy",
    args: &["acp"],
    min: [1, 5, 0],
    below: [1, 6, 0],
    terms: Some(Terms {
        en: "Google may close accounts used outside its own products.",
        tr: "Google, kendi ürünleri dışında kullanılan hesapları kapatabilir.",
    }),
    verified: false,
}];

/// Asks the person on this computer. The answer is `true` for allow, and anything else refuses.
pub trait Approvals: Send + Sync {
    fn ask(&self, text: &str) -> oneshot::Receiver<bool>;
    /// The question was refused for lack of an answer: tell the person that what they may still
    /// see open does nothing now.
    fn ended(&self, text: &str);
}

/// The waits of a session, apart so a test can shorten them.
#[derive(Clone, Copy)]
pub struct Timing {
    /// How long the person has to answer.
    pub approval: Duration,
    /// How long a session may stay without a turn.
    pub idle: Duration,
    /// How long a cancelled turn has to end before the session is closed.
    pub cancel: Duration,
    /// How long a bot tool has to answer.
    pub tool: Duration,
    /// How often a running turn says it is alive.
    pub heartbeat: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            approval: Duration::from_secs(5 * 60),
            idle: Duration::from_secs(30 * 60),
            cancel: Duration::from_secs(10),
            tool: Duration::from_secs(10 * 60),
            heartbeat: Duration::from_secs(30),
        }
    }
}

const MAX_SESSIONS: usize = 4;
const PROTOCOL_VERSION: u64 = 1;
/// An answer to `initialize` or `session/new`; a turn itself has no limit here (the server has).
const REQUEST_WAIT: Duration = Duration::from_secs(30);
const TEXT_FLUSH: Duration = Duration::from_millis(100);
const TEXT_PIECE: usize = 16 * 1024;
const LINE_MAX: usize = 4 * 1024 * 1024;
const TOOL_ARGS_MAX: usize = 256 * 1024;
const FILE_MAX: u64 = 8 * 1024 * 1024;
const DIALOG_MAX: usize = 2000;
const SEEN_DAYS: u64 = 7;
const SEEN_LINES: usize = 10_000;
const MCP_SERVER: &str = "dozo";

const INTERRUPTED: &str = "The agent was interrupted: its process ended before this turn finished. Send the message again.";
/// What the person is told about a question that was not put to them.
const UNSHOWN: &str = "This request could not be shown safely, so it was refused.";
/// Questions of one turn that may be refused (or go unanswered) before the turn is stopped.
const REFUSALS: u32 = 3;

fn unchecked(name: &str) -> String {
    format!("This {name} version has not been checked with Dozo yet.")
}

fn signed_out(name: &str) -> String {
    format!(
        "{name} on this computer is not signed in. Sign in to it once in a terminal, then try again."
    )
}

fn outside(name: &str) -> String {
    format!("{name} reached outside the bot's folder without asking, so the turn was stopped.")
}

const NOT_ALLOWED: &str = "The person did not allow this.";

// ---------------------------------------------------------------------------------------------
// The requests, strictly as the protocol's schema has them: a key it does not name is refused.

/// The most characters a protocol string may hold, counted as the server counts them (UTF-16).
fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

fn text_in<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
) -> Option<&'a str> {
    let text = object.get(key)?.as_str()?;
    (min..=max).contains(&len16(text)).then_some(text)
}

fn only(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.keys().all(|key| keys.contains(&key.as_str()))
}

/// `^[a-z0-9][a-z0-9-]{0,63}$`
fn agent_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, and no `..`.
fn model_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(b))
        && !text.contains("..")
}

/// `^[A-Za-z0-9_.-]{1,128}$`
fn tool_name(text: &str) -> bool {
    (1..=128).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

pub enum Request {
    Turn {
        bot: String,
        run: String,
        agent: String,
        instructions: String,
        input: String,
        /// Each exactly `{ name, description, inputSchema }`.
        tools: Vec<Value>,
    },
    ToolResult {
        bot: String,
        run: String,
        call_id: String,
        text: String,
        is_error: bool,
    },
    Stop {
        bot: String,
        run: String,
    },
}

pub fn parse_request(request: &Value) -> Option<Request> {
    let object = request.as_object()?;
    let bot = text_in(object, "botId", 1, 256)?.to_owned();
    let run = text_in(object, "runId", 1, 256)?.to_owned();
    match object.get("method")?.as_str()? {
        "agentTurn" => {
            if !only(
                object,
                &[
                    "method",
                    "botId",
                    "runId",
                    "agent",
                    "model",
                    "instructions",
                    "input",
                    "tools",
                ],
            ) {
                return None;
            }
            let agent = text_in(object, "agent", 1, 64).filter(|agent| agent_id(agent))?;
            // A model is checked like the server checks it, and then never used: this agent
            // chooses its own, and nothing the server sends reaches its arguments.
            if let Some(model) = object.get("model") {
                model_id(model.as_str()?).then_some(())?;
            }
            let instructions = text_in(object, "instructions", 0, 512 * 1024)?;
            let input = text_in(object, "input", 1, 2 * 1024 * 1024)?;
            let tools = object
                .get("tools")?
                .as_array()
                .filter(|tools| tools.len() <= 256)?;
            for tool in tools {
                let tool = tool.as_object()?;
                if !only(tool, &["name", "description", "inputSchema"]) {
                    return None;
                }
                tool_name(tool.get("name")?.as_str()?).then_some(())?;
                text_in(tool, "description", 0, 16 * 1024)?;
                tool.get("inputSchema")?.as_object()?;
            }
            if len16(&serde_json::to_string(tools).ok()?) > 1024 * 1024 {
                return None;
            }
            Some(Request::Turn {
                bot,
                run,
                agent: agent.to_owned(),
                instructions: instructions.to_owned(),
                input: input.to_owned(),
                tools: tools.clone(),
            })
        }
        "agentToolResult" => {
            if !only(
                object,
                &["method", "botId", "runId", "callId", "text", "isError"],
            ) {
                return None;
            }
            Some(Request::ToolResult {
                bot,
                run,
                call_id: text_in(object, "callId", 1, 64)?.to_owned(),
                text: text_in(object, "text", 0, 1024 * 1024)?.to_owned(),
                is_error: object.get("isError")?.as_bool()?,
            })
        }
        "agentStop" => {
            only(object, &["method", "botId", "runId"]).then_some(Request::Stop { bot, run })
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// What this computer lets bots do, and the runs it has seen.

/// The runs this computer has started, kept so a run whose process is gone is never started
/// again from nothing: seven days, and the last ten thousand.
struct Seen {
    file: PathBuf,
    order: VecDeque<(u64, String)>,
    runs: HashSet<String>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// A run id on one line.
fn one_line(run: &str) -> String {
    run.replace(['\n', '\r'], " ")
}

impl Seen {
    fn load(file: PathBuf) -> Self {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        let oldest = now_secs().saturating_sub(SEEN_DAYS * 24 * 3600);
        let mut order: VecDeque<(u64, String)> = text
            .lines()
            .filter_map(|line| {
                let (at, run) = line.split_once(' ')?;
                Some((
                    at.parse::<u64>().ok().filter(|at| *at >= oldest)?,
                    run.to_owned(),
                ))
            })
            .collect();
        let before = text.lines().count();
        while order.len() > SEEN_LINES {
            order.pop_front();
        }
        let runs = order.iter().map(|(_, run)| run.clone()).collect();
        let seen = Seen { file, order, runs };
        if before != seen.order.len() {
            seen.rewrite();
        }
        seen
    }

    fn rewrite(&self) {
        let text: String = self
            .order
            .iter()
            .map(|(at, run)| format!("{at} {run}\n"))
            .collect();
        let _ = std::fs::write(&self.file, text);
    }

    fn has(&self, run: &str) -> bool {
        self.runs.contains(&one_line(run))
    }

    fn mark(&mut self, run: &str) {
        let run = one_line(run);
        let at = now_secs();
        self.order.push_back((at, run.clone()));
        self.runs.insert(run.clone());
        let mut trimmed = false;
        while self.order.len() > SEEN_LINES {
            if let Some((_, old)) = self.order.pop_front()
                && !self.order.iter().any(|(_, kept)| *kept == old)
            {
                self.runs.remove(&old);
            }
            trimmed = true;
        }
        if let Some(folder) = self.file.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        if trimmed {
            self.rewrite();
        } else if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file)
        {
            use std::io::Write;
            let _ = writeln!(file, "{at} {run}");
        }
    }
}

struct Shared {
    /// `<app data>/computers`: every bot's folder is under it.
    computers: PathBuf,
    catalog: Mutex<&'static [Entry]>,
    enabled: Mutex<HashSet<String>>,
    config: Mutex<Option<PathBuf>>,
    approvals: Mutex<Option<Arc<dyn Approvals>>>,
    /// The person's login shell's `PATH`, read once, when first needed.
    path: Mutex<Option<String>>,
    timing: Mutex<Timing>,
    sessions: Mutex<HashMap<(String, String), Arc<Session>>>,
    /// Sessions being started (their process is up, the session is not open yet).
    starting: Mutex<HashSet<(String, String)>>,
    seen: Mutex<Seen>,
    /// A question is open on the person's screen: only one at a time.
    asking: AtomicBool,
}

impl Shared {
    fn entry(&self, id: &str) -> Option<&'static Entry> {
        self.catalog
            .lock()
            .unwrap()
            .iter()
            .find(|entry| entry.id == id)
    }

    fn is_enabled(&self, id: &str) -> bool {
        self.enabled.lock().unwrap().contains(id)
    }

    fn timing(&self) -> Timing {
        *self.timing.lock().unwrap()
    }

    /// Blocks while the login shell answers (five seconds at most).
    fn path(&self) -> String {
        if let Some(path) = self.path.lock().unwrap().clone() {
            return path;
        }
        let found = std::env::var("SHELL")
            .ok()
            .and_then(|shell| crate::stack_setup::login_path(Path::new(&shell)))
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        self.path.lock().unwrap().get_or_insert(found).clone()
    }

    fn save(&self) {
        let Some(file) = self.config.lock().unwrap().clone() else {
            return;
        };
        let mut enabled: Vec<String> = self.enabled.lock().unwrap().iter().cloned().collect();
        enabled.sort();
        if let Some(folder) = file.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        if let Err(error) = std::fs::write(&file, json!({ "enabled": enabled }).to_string()) {
            eprintln!("dozo: could not save the agents the person allowed: {error}");
        }
    }
}

/// The agents bots may use on this computer, and their live sessions.
pub struct Agents(Arc<Shared>);

impl Agents {
    /// `dir` holds what is kept between runs of the app (the runs seen).
    pub fn new(dir: PathBuf) -> Self {
        Agents(Arc::new(Shared {
            computers: dir.parent().map(Path::to_path_buf).unwrap_or_default(),
            seen: Mutex::new(Seen::load(dir.join("seen"))),
            catalog: Mutex::new(CATALOG),
            enabled: Mutex::default(),
            config: Mutex::new(None),
            approvals: Mutex::new(None),
            path: Mutex::new(None),
            timing: Mutex::new(Timing::default()),
            sessions: Mutex::default(),
            starting: Mutex::default(),
            asking: AtomicBool::new(false),
        }))
    }

    /// For a fake agent in a test: the entries the app offers.
    #[cfg(test)]
    pub fn set_catalog(&self, catalog: &'static [Entry]) {
        *self.0.catalog.lock().unwrap() = catalog;
    }

    pub fn catalog(&self) -> &'static [Entry] {
        *self.0.catalog.lock().unwrap()
    }

    pub fn set_approvals(&self, approvals: Arc<dyn Approvals>) {
        *self.0.approvals.lock().unwrap() = Some(approvals);
    }

    /// Reads what the person allowed from `file` (`{"enabled": [ids]}`), and keeps it there. A file
    /// that is missing or not ours allows nothing.
    pub fn set_config(&self, file: PathBuf) {
        let enabled = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| {
                value.get("enabled")?.as_array().map(|ids| {
                    ids.iter()
                        .filter_map(|id| id.as_str().map(str::to_owned))
                        .collect::<HashSet<_>>()
                })
            })
            .unwrap_or_default();
        *self.0.enabled.lock().unwrap() = enabled;
        *self.0.config.lock().unwrap() = Some(file);
    }

    pub fn enabled(&self, id: &str) -> bool {
        self.0.is_enabled(id)
    }

    /// Turning an agent off closes every session of it.
    pub fn set_enabled(&self, id: &str, on: bool) {
        if self.0.entry(id).is_none() {
            return;
        }
        {
            let mut enabled = self.0.enabled.lock().unwrap();
            if on {
                enabled.insert(id.to_owned());
            } else {
                enabled.remove(id);
            }
        }
        self.0.save();
        if !on {
            self.close_where(|session| session.entry.id == id);
        }
    }

    /// For a test: the `PATH` the agents are looked for on and started with.
    #[cfg(test)]
    pub fn set_path(&self, path: String) {
        *self.0.path.lock().unwrap() = Some(path);
    }

    #[cfg(test)]
    pub fn set_timing(&self, timing: Timing) {
        *self.0.timing.lock().unwrap() = timing;
    }

    /// The catalog's verified agents found on the person's login `PATH`, allowed or not.
    pub async fn found(&self) -> Vec<&'static Entry> {
        let shared = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let path = shared.path();
            shared
                .catalog
                .lock()
                .unwrap()
                .iter()
                .filter(|entry| entry.verified && find_on_path(entry.command, &path).is_some())
                .collect()
        })
        .await
        .unwrap_or_default()
    }

    /// What the server is told this computer can do: the agents the person allowed and that are
    /// installed.
    pub async fn offered(&self) -> Vec<&'static str> {
        if !self
            .0
            .catalog
            .lock()
            .unwrap()
            .iter()
            .any(|entry| self.0.is_enabled(entry.id))
        {
            return Vec::new();
        }
        self.found()
            .await
            .into_iter()
            .filter(|entry| self.0.is_enabled(entry.id))
            .map(|entry| entry.id)
            .collect()
    }

    #[cfg(test)]
    pub fn live(&self) -> usize {
        self.0.sessions.lock().unwrap().len()
    }

    #[cfg(test)]
    pub fn has_seen(&self, run: &str) -> bool {
        self.0.seen.lock().unwrap().has(run)
    }

    #[cfg(test)]
    pub fn seen_count(&self) -> usize {
        self.0.seen.lock().unwrap().order.len()
    }

    fn close_where(&self, matches: impl Fn(&Session) -> bool) {
        let found: Vec<Arc<Session>> = self
            .0
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|session| matches(session))
            .cloned()
            .collect();
        for session in found {
            session.close();
        }
    }

    pub fn close_all(&self) {
        self.close_where(|_| true);
    }

    pub fn close_bot(&self, bot_key: &str) {
        self.close_where(|session| session.key.0 == bot_key);
    }

    /// Answers one `agentTurn`, `agentToolResult` or `agentStop`.
    pub async fn handle(&self, runner: &Runner, request: &Value, reply: &Reply) {
        match parse_request(request) {
            None => reply.error(INVALID).await,
            Some(Request::Turn {
                bot,
                run,
                agent,
                instructions,
                input,
                tools,
            }) => {
                self.turn(
                    runner,
                    (bot, run),
                    &agent,
                    instructions,
                    input,
                    tools,
                    reply,
                )
                .await;
            }
            Some(Request::ToolResult {
                bot,
                run,
                call_id,
                text,
                is_error,
            }) => {
                let session = self
                    .0
                    .sessions
                    .lock()
                    .unwrap()
                    .get(&(bot_key(&bot), run))
                    .cloned();
                let waiting = session
                    .and_then(|session| session.st.lock().unwrap().tool_waits.remove(&call_id));
                match waiting {
                    Some(waiting) => {
                        let _ = waiting.send((text, is_error));
                        reply.send(json!({ "done": true })).await;
                    }
                    None => reply.error(INVALID).await,
                }
            }
            Some(Request::Stop { bot, run }) => {
                let session = self
                    .0
                    .sessions
                    .lock()
                    .unwrap()
                    .get(&(bot_key(&bot), run))
                    .cloned();
                if let Some(session) = session {
                    session.close();
                }
                reply.send(json!({ "done": true })).await;
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn turn(
        &self,
        runner: &Runner,
        (bot, run): (String, String),
        agent: &str,
        instructions: String,
        input: String,
        tools: Vec<Value>,
        reply: &Reply,
    ) {
        let shared = &self.0;
        let Some(entry) = shared
            .entry(agent)
            .filter(|entry| entry.verified && shared.is_enabled(entry.id))
        else {
            return reply.error(NOT_HERE).await;
        };
        let key = (bot_key(&bot), run.clone());
        let live = shared.sessions.lock().unwrap().get(&key).cloned();
        let session = match live {
            Some(session) if session.entry.id == entry.id => session,
            Some(_) => return reply.error(INVALID).await,
            None => {
                // A run seen before whose process is gone is never started again from nothing; one
                // that finds the places taken, or its own start under way, waits for nothing.
                let gate = {
                    let seen = shared.seen.lock().unwrap();
                    let mut starting = shared.starting.lock().unwrap();
                    if starting.contains(&key) {
                        Some(BUSY)
                    } else if seen.has(&run) {
                        Some(INTERRUPTED)
                    } else if shared.sessions.lock().unwrap().len() + starting.len() >= MAX_SESSIONS
                    {
                        Some(BUSY)
                    } else {
                        starting.insert(key.clone());
                        None
                    }
                };
                match gate {
                    Some(INTERRUPTED) => return failed(reply, INTERRUPTED).await,
                    Some(busy) => return reply.error(busy).await,
                    None => {}
                }
                let _starting = Starting(shared.clone(), key.clone());
                let home = runner.person_home().to_path_buf();
                let folder = runner.bot_home(&bot);
                let starting = Session::start(
                    shared.clone(),
                    key.clone(),
                    entry,
                    folder,
                    home,
                    instructions,
                );
                match beating(reply, shared.timing().heartbeat, starting).await {
                    None => return,
                    Some(Err(message)) => return failed(reply, &message).await,
                    Some(Ok(session)) => session,
                }
            }
        };
        let free = {
            let mut state = session.st.lock().unwrap();
            let free = !state.busy;
            if free {
                state.busy = true;
                state.tools = tools;
            }
            free
        };
        if !free {
            return reply.error(BUSY).await;
        }
        session.run_turn(input, reply).await;
    }
}

/// A session being started, counted until it is open or the start failed.
struct Starting(Arc<Shared>, (String, String));

impl Drop for Starting {
    fn drop(&mut self) {
        self.0.starting.lock().unwrap().remove(&self.1);
    }
}

/// One question open at a time; released when the answer is known.
struct Asking<'a>(&'a AtomicBool);

impl Drop for Asking<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Runs `work`, with a heartbeat while it takes long; `None` when the call was cancelled first
/// (what `work` held is dropped, which ends a session that was starting).
async fn beating<T>(reply: &Reply, every: Duration, work: impl Future<Output = T>) -> Option<T> {
    tokio::pin!(work);
    let mut cancel = reply.cancel.clone();
    let mut beat = interval(every);
    beat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    beat.tick().await;
    loop {
        tokio::select! {
            result = &mut work => return Some(result),
            _ = beat.tick() => {
                if !reply.send(json!({ "heartbeat": true })).await {
                    return None;
                }
            }
            _ = cancelled(&mut cancel) => return None,
        }
    }
}

async fn put(reply: &Reply, frame: Value) -> bool {
    reply.send(json!({ "value": frame })).await
}

/// A turn that ends at once: `failed`, then the end of the stream.
async fn failed(reply: &Reply, message: &str) {
    if put(reply, failed_frame(message)).await {
        reply.send(json!({ "done": true })).await;
    }
}

fn failed_frame(message: &str) -> Value {
    json!({ "type": "failed", "message": cut(message, 4096) })
}

/// At most `max` UTF-16 units (as the protocol counts), never half a character.
fn cut(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut kept = String::new();
    for character in text.chars() {
        units += character.len_utf16();
        if units > max {
            break;
        }
        kept.push(character);
    }
    kept
}

/// An executable file called `command` in one of the absolute folders of `path`: a relative one
/// would mean the app's own working folder.
fn find_on_path(command: &str, path: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path)
        .filter(|folder| folder.is_absolute())
        .map(|folder| folder.join(command))
        .find(|file| {
            std::fs::metadata(file)
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
}

/// The first `x.y.z` in the agent's version text, within the entry's range.
fn in_range(version: &str, entry: &Entry) -> bool {
    let bytes = version.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() || (start > 0 && bytes[start - 1].is_ascii_digit()) {
            continue;
        }
        let parts: Vec<u32> = version[start..]
            .splitn(3, '.')
            .map(|part| {
                part.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
            })
            .map(|digits| digits.parse().unwrap_or(u32::MAX))
            .collect();
        if parts.len() == 3 && parts.iter().all(|part| *part != u32::MAX) {
            let found = [parts[0], parts[1], parts[2]];
            return found >= entry.min && found < entry.below;
        }
    }
    false
}

// ---------------------------------------------------------------------------------------------
// One session: the agent's process and the conversation with it.

#[derive(Debug)]
struct Fail {
    message: String,
    code: Option<i64>,
}

#[derive(Default)]
struct State {
    busy: bool,
    /// Where the running turn's frames go; none between turns.
    sink: Option<mpsc::Sender<Value>>,
    /// The turn's tools.
    tools: Vec<Value>,
    /// The bot's instructions, carried by the first prompt.
    lead: String,
    idle_since: Option<Instant>,
    calls: u64,
    tool_waits: HashMap<String, oneshot::Sender<(String, bool)>>,
    /// Paths and tool calls the person allowed in this turn.
    approved: HashSet<PathBuf>,
    approved_calls: HashSet<String>,
    /// Tool calls that name a place outside the bot's folder and were not allowed (yet).
    suspects: HashSet<String>,
    violation: bool,
    /// Questions of this turn that were refused or went unanswered.
    refused: u32,
}

struct Session {
    shared: Arc<Shared>,
    key: (String, String),
    entry: &'static Entry,
    /// The bot's folder, as the system names it.
    root: PathBuf,
    session_id: Mutex<String>,
    pid: u32,
    mark: String,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    next_id: AtomicU64,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Result<Value, Fail>>>>,
    st: Mutex<State>,
    /// Counts the turns that ended or were cancelled: what waits for the person or for a tool
    /// gives up when it changes.
    epoch: watch::Sender<u64>,
    closed: watch::Sender<bool>,
    bridge_dir: PathBuf,
    bridge_key: String,
}

/// Closes the session unless the start went through (a cancelled start drops it).
struct CloseOnDrop(Option<Arc<Session>>);

impl CloseOnDrop {
    fn keep(mut self) -> Arc<Session> {
        self.0.take().expect("kept once")
    }
}

impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        if let Some(session) = self.0.take() {
            session.close();
        }
    }
}

enum Decision {
    Allow,
    Deny,
    Expired,
    Cancelled,
    /// Another question is open: this one was not asked.
    Busy,
    /// It could not be shown safely: not asked, and refused.
    Refused,
}

impl Session {
    /// Starts the process and the bridge to the bot's tools, then agrees on the protocol and opens
    /// the session. The error is what the server is told.
    async fn start(
        shared: Arc<Shared>,
        key: (String, String),
        entry: &'static Entry,
        folder: PathBuf,
        home: PathBuf,
        instructions: String,
    ) -> Result<Arc<Session>, String> {
        let path = {
            let shared = shared.clone();
            tokio::task::spawn_blocking(move || shared.path())
                .await
                .unwrap_or_default()
        };
        let Some(program) = find_on_path(entry.command, &path) else {
            return Err(format!("{} is not installed on this computer.", entry.name));
        };
        let unreachable = format!("{} did not start as an ACP agent as expected.", entry.name);
        create_private(&folder).map_err(|_| unreachable.clone())?;
        let root = folder.canonicalize().map_err(|_| unreachable.clone())?;
        // A folder, or one of its parents, that is a link leading out of the app's data is not
        // the bot's own folder.
        let base = shared
            .computers
            .canonicalize()
            .map_err(|_| unreachable.clone())?;
        if !root.starts_with(&base) {
            return Err(unreachable);
        }
        let name = random_hex(8).ok_or_else(|| unreachable.clone())?;
        let bridge_key = random_hex(32).ok_or_else(|| unreachable.clone())?;
        let bridge_dir = std::env::temp_dir().join(format!("dozo-agent-{name}"));
        // What goes to the agent as JSON must be text: a path that is not leaves nothing started.
        let exe = std::env::current_exe().map_err(|_| unreachable.clone())?;
        if [&root, &bridge_dir, &exe, &home]
            .iter()
            .any(|path| path.to_str().is_none())
        {
            return Err(unreachable);
        }
        create_private(&bridge_dir).map_err(|_| unreachable.clone())?;
        let socket = bridge_dir.join("s");
        let listener = UnixListener::bind(&socket).map_err(|_| {
            let _ = std::fs::remove_dir_all(&bridge_dir);
            unreachable.clone()
        })?;
        let mark = new_mark();
        let mut command = Command::new(&program);
        command
            .args(entry.args)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_clear()
            .envs(environment(
                std::env::vars_os(),
                &[
                    (
                        "HOME".to_owned(),
                        home.to_str().unwrap_or_default().to_owned(),
                    ),
                    ("PATH".to_owned(), path),
                ],
                &[],
            ))
            .env(MARK_VAR, &mark);
        own_group(&mut command);
        let mut child = command.spawn().map_err(|_| {
            let _ = std::fs::remove_dir_all(&bridge_dir);
            unreachable.clone()
        })?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.start_kill();
            let _ = std::fs::remove_dir_all(&bridge_dir);
            return Err(unreachable);
        };
        let session = Arc::new(Session {
            shared: shared.clone(),
            key,
            entry,
            root,
            session_id: Mutex::new(String::new()),
            pid: child.id().unwrap_or(0),
            mark,
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            next_id: AtomicU64::new(0),
            waiting: Mutex::default(),
            st: Mutex::new(State {
                lead: lead(&instructions),
                ..State::default()
            }),
            epoch: watch::channel(0).0,
            closed: watch::channel(false).0,
            bridge_dir,
            bridge_key,
        });
        let guard = CloseOnDrop(Some(session.clone()));
        tokio::spawn(session.clone().read(stdout, child));
        tokio::spawn(session.clone().accept(listener));
        session.handshake(&socket).await?;
        {
            let mut sessions = shared.sessions.lock().unwrap();
            if sessions.len() >= MAX_SESSIONS {
                return Err(BUSY.to_owned());
            }
            sessions.insert(session.key.clone(), session.clone());
        }
        // Only a session that opened counts as seen: a start that failed may be tried again.
        shared.seen.lock().unwrap().mark(&session.key.1);
        session.st.lock().unwrap().idle_since = Some(Instant::now());
        tokio::spawn(session.clone().watch_idle(shared.timing().idle));
        Ok(guard.keep())
    }

    async fn handshake(self: &Arc<Self>, socket: &Path) -> Result<(), String> {
        let name = self.entry.name;
        let answer = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true },
                        "terminal": false },
                    "clientInfo": { "name": "dozo", "title": "Dozo", "version": "1" },
                }),
                Some(REQUEST_WAIT),
            )
            .await
            .map_err(|fail| fail.message)?;
        let version = answer
            .pointer("/agentInfo/version")
            .and_then(Value::as_str)
            .unwrap_or("");
        if answer.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
            || !in_range(version, self.entry)
        {
            return Err(unchecked(name));
        }
        let exe = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.to_str().map(str::to_owned))
            .ok_or_else(|| format!("{name} could not reach Dozo's tools."))?;
        let answer = self
            .request(
                "session/new",
                json!({
                    "cwd": self.root.to_str(),
                    "mcpServers": [{
                        "name": MCP_SERVER,
                        "command": exe,
                        "args": [crate::agent_bridge::FLAG],
                        "env": [
                            { "name": "DOZO_BRIDGE_SOCKET", "value": socket.to_str() },
                            { "name": "DOZO_BRIDGE_KEY", "value": self.bridge_key },
                        ],
                    }],
                }),
                Some(REQUEST_WAIT),
            )
            .await
            .map_err(|fail| {
                let said = format!(
                    "{} {}",
                    fail.message,
                    fail.code.map(|code| code.to_string()).unwrap_or_default()
                );
                if said.to_ascii_lowercase().contains("auth") {
                    signed_out(name)
                } else {
                    fail.message
                }
            })?;
        match answer.get("sessionId").and_then(Value::as_str) {
            Some(id) => {
                *self.session_id.lock().unwrap() = id.to_owned();
                Ok(())
            }
            None => Err(format!("{name} did not start as an ACP agent as expected.")),
        }
    }

    fn session_id(&self) -> String {
        self.session_id.lock().unwrap().clone()
    }

    // --- the conversation

    async fn write(&self, message: Value) -> bool {
        let mut message = message;
        message["jsonrpc"] = json!("2.0");
        let line = format!("{message}\n");
        let mut stdin = self.stdin.lock().await;
        let Some(stdin) = stdin.as_mut() else {
            return false;
        };
        stdin.write_all(line.as_bytes()).await.is_ok() && stdin.flush().await.is_ok()
    }

    fn stopped(&self) -> Fail {
        Fail {
            message: format!("{} stopped.", self.entry.name),
            code: None,
        }
    }

    /// Writes a request; the answer is waited for with `finish`.
    async fn begin(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(u64, oneshot::Receiver<Result<Value, Fail>>), Fail> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (send, receive) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id, send);
        if *self.closed.borrow()
            || !self
                .write(json!({ "id": id, "method": method, "params": params }))
                .await
        {
            self.waiting.lock().unwrap().remove(&id);
            return Err(self.stopped());
        }
        Ok((id, receive))
    }

    async fn finish(
        &self,
        method: &str,
        id: u64,
        receive: oneshot::Receiver<Result<Value, Fail>>,
        wait: Option<Duration>,
    ) -> Result<Value, Fail> {
        let answer = match wait {
            None => receive.await,
            Some(wait) => match timeout(wait, receive).await {
                Ok(answer) => answer,
                Err(_) => {
                    self.waiting.lock().unwrap().remove(&id);
                    return Err(Fail {
                        message: format!("{} did not answer {method}.", self.entry.name),
                        code: None,
                    });
                }
            },
        };
        answer.unwrap_or_else(|_| Err(self.stopped()))
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        wait: Option<Duration>,
    ) -> Result<Value, Fail> {
        let (id, receive) = self.begin(method, params).await?;
        self.finish(method, id, receive, wait).await
    }

    async fn respond(&self, id: Value, body: Result<Value, (i64, String)>) {
        let message = match body {
            Ok(result) => json!({ "id": id, "result": result }),
            Err((code, message)) => {
                json!({ "id": id, "error": { "code": code, "message": message } })
            }
        };
        self.write(message).await;
    }

    /// Reads the agent's lines until its output ends, which is the end of the process.
    async fn read(
        self: Arc<Self>,
        stdout: tokio::process::ChildStdout,
        mut child: tokio::process::Child,
    ) {
        let mut lines = BufReader::new(stdout);
        loop {
            match read_line(&mut lines).await {
                Line::Text(line) => {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    self.dispatch(message).await;
                }
                Line::End => break,
                Line::TooLong => {
                    let said = format!("{} sent a message that is too large.", self.entry.name);
                    self.emit(failed_frame(&said)).await;
                    break;
                }
            }
        }
        if !*self.closed.borrow() {
            self.emit(failed_frame(&self.stopped().message)).await;
        }
        self.close();
        let _ = child.wait().await;
    }

    async fn dispatch(self: &Arc<Self>, message: Value) {
        let id = message.get("id").filter(|id| !id.is_null()).cloned();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match (message.get("method").and_then(Value::as_str), id) {
            (None, Some(id)) => {
                let Some(waiting) = id
                    .as_u64()
                    .and_then(|id| self.waiting.lock().unwrap().remove(&id))
                else {
                    return;
                };
                let _ = waiting.send(match message.get("error") {
                    Some(error) => Err(Fail {
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .map_or_else(|| format!("{} refused.", self.entry.name), str::to_owned),
                        code: error.get("code").and_then(Value::as_i64),
                    }),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                });
            }
            (Some(method), Some(id)) => {
                let method = method.to_owned();
                tokio::spawn(self.clone().on_request(id, method, params));
            }
            (Some("session/update"), None) => self.on_update(&params).await,
            _ => {}
        }
    }

    /// Hands a frame to the running turn; false when none runs.
    /// Waits when the turn is behind, so a flood from the agent waits too.
    async fn emit(&self, frame: Value) -> bool {
        let sink = self.st.lock().unwrap().sink.clone();
        match sink {
            Some(sink) => sink.send(frame).await.is_ok(),
            None => false,
        }
    }

    /// The turn is over or cancelled: whatever waits for the person or for a tool gives up.
    fn turn_over(&self) {
        self.epoch.send_modify(|epoch| *epoch += 1);
        self.st.lock().unwrap().tool_waits.clear();
    }

    // --- what the agent says during a turn

    async fn on_update(&self, params: &Value) {
        if params.get("sessionId").and_then(Value::as_str) != Some(self.session_id().as_str()) {
            return;
        }
        let Some(update) = params.get("update") else {
            return;
        };
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    self.emit(json!({ "type": "text", "text": text })).await;
                }
            }
            Some("tool_call") => {
                if let Some(title) = update.get("title").and_then(Value::as_str) {
                    self.emit(json!({ "type": "activity", "text": cut(title, 1024) }))
                        .await;
                }
                self.watch_reach(update).await;
            }
            Some("tool_call_update") => self.watch_reach(update).await,
            _ => {}
        }
    }

    /// Catches a tool that reaches outside the bot's folder without the person's yes, as far as
    /// the agent tells: it stops the turn. Not a full protection (the agent may not say).
    async fn watch_reach(&self, update: &Value) {
        let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
            return;
        };
        let running = matches!(
            update.get("status").and_then(Value::as_str),
            Some("in_progress" | "completed")
        );
        let reaches = update
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| ["read", "search", "edit", "delete", "move"].contains(&kind))
            && self.outside_unapproved(update);
        let violation = {
            let mut state = self.st.lock().unwrap();
            if state.approved_calls.contains(id) || state.violation {
                return;
            }
            if reaches {
                state.suspects.insert(id.to_owned());
            }
            if running && state.suspects.contains(id) {
                state.violation = true;
                true
            } else {
                false
            }
        };
        if violation {
            self.emit(failed_frame(&outside(self.entry.name))).await;
        }
    }

    fn outside_unapproved(&self, update: &Value) -> bool {
        let state = self.st.lock().unwrap();
        paths_of(update).iter().any(|path| {
            let resolved = resolve(&self.root, path);
            !resolved.starts_with(&self.root) && !state.approved.contains(&resolved)
        })
    }

    async fn on_request(self: Arc<Self>, id: Value, method: String, params: Value) {
        let in_session =
            params.get("sessionId").and_then(Value::as_str) == Some(self.session_id().as_str());
        let turn_runs = self.st.lock().unwrap().sink.is_some();
        match method.as_str() {
            "session/request_permission" => {
                let outcome = if in_session && turn_runs {
                    self.permission(&params).await
                } else {
                    json!({ "outcome": "cancelled" })
                };
                self.respond(id, Ok(json!({ "outcome": outcome }))).await;
            }
            "fs/read_text_file" | "fs/write_text_file" if in_session && turn_runs => {
                let result = if method == "fs/read_text_file" {
                    self.read_file(&params).await
                } else {
                    self.write_file(&params).await
                };
                self.respond(id, result).await;
            }
            "fs/read_text_file" | "fs/write_text_file" => {
                self.respond(id, Err((-32000, "No turn is running.".to_owned())))
                    .await;
            }
            _ => {
                self.respond(id, Err((-32601, "Dozo does not offer this.".to_owned())))
                    .await
            }
        }
    }

    /// What the agent asked before it goes on, put to the person here. Only the one-time options
    /// are ever chosen; with none, the request is cancelled.
    async fn permission(&self, params: &Value) -> Value {
        let call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let (kind, title, paths, input) = approval(&call);
        let decision = self
            .ask(kind, title.as_deref(), &paths, input.as_ref())
            .await;
        let wanted = match decision {
            Decision::Allow => "allow_once",
            Decision::Deny | Decision::Expired | Decision::Refused => "reject_once",
            Decision::Cancelled | Decision::Busy => "",
        };
        if matches!(decision, Decision::Allow) {
            let mut state = self.st.lock().unwrap();
            if let Some(id) = call.get("toolCallId").and_then(Value::as_str) {
                state.suspects.remove(id);
                state.approved_calls.insert(id.to_owned());
            }
            for path in paths_of(&call) {
                state.approved.insert(resolve(&self.root, &path));
            }
        }
        params
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|option| {
                option.get("kind").and_then(Value::as_str) == Some(wanted)
                    && option.get("optionId").is_some_and(Value::is_string)
            })
            .map_or_else(
                || json!({ "outcome": "cancelled" }),
                |option| json!({ "outcome": "selected", "optionId": option["optionId"] }),
            )
    }

    /// The person's answer to one question; the server hears only that the app waits, and, when
    /// nobody answers in time, that the agent was told no. Only one question is open at a time:
    /// another one is not asked.
    async fn ask(
        &self,
        kind: &str,
        title: Option<&str>,
        paths: &[String],
        input: Option<&Value>,
    ) -> Decision {
        let decision = self.ask_once(kind, title, paths, input).await;
        if matches!(
            decision,
            Decision::Deny | Decision::Expired | Decision::Refused
        ) {
            self.refused_one().await;
        }
        decision
    }

    /// A refused question; the turn that goes on asking what is refused is stopped.
    async fn refused_one(&self) {
        let stop = {
            let mut state = self.st.lock().unwrap();
            state.refused += 1;
            let stop = state.refused > REFUSALS && !state.violation;
            state.violation |= stop;
            stop
        };
        if stop {
            let said = format!(
                "{} asked too many questions that were refused, so the turn was stopped.",
                self.entry.name
            );
            self.emit(failed_frame(&said)).await;
        }
    }

    async fn ask_once(
        &self,
        kind: &str,
        title: Option<&str>,
        paths: &[String],
        input: Option<&Value>,
    ) -> Decision {
        let Some(approvals) = self.shared.approvals.lock().unwrap().clone() else {
            return Decision::Deny;
        };
        if self.shared.asking.swap(true, Ordering::SeqCst) {
            return Decision::Busy;
        }
        let _open = Asking(&self.shared.asking);
        let mut over = self.epoch.subscribe();
        let first = *over.borrow_and_update();
        let mut closed = self.closed.subscribe();
        let head = asks(self.entry.name, kind, crate::words::turkish());
        let Some(text) = dialog_text(&head, title, paths, input) else {
            self.emit(json!({ "type": "activity", "text": UNSHOWN }))
                .await;
            return Decision::Refused;
        };
        let summary = asks(self.entry.name, kind, false);
        self.emit(json!({ "type": "approvalWaiting", "summary": cut(&summary, 1024) }))
            .await;
        let answer = approvals.ask(&text);
        let decision = tokio::select! {
            answered = answer => {
                return if answered == Ok(true) { Decision::Allow } else { Decision::Deny };
            }
            () = sleep(self.shared.timing().approval) => {
                self.emit(json!({ "type": "approvalExpired", "summary": cut(&summary, 1024) })).await;
                Decision::Expired
            }
            () = async { let _ = over.wait_for(|epoch| *epoch != first).await; } => Decision::Cancelled,
            () = async { let _ = closed.wait_for(|closed| *closed).await; } => Decision::Cancelled,
        };
        // What may still be open on the screen does nothing now.
        approvals.ended(&text);
        decision
    }

    /// `fs/read_text_file`: free inside the bot's folder, asked about outside it (and a link out
    /// of the folder counts as outside). Only an ordinary file is read, and never more than
    /// `FILE_MAX` of it.
    async fn read_file(&self, params: &Value) -> Result<Value, (i64, String)> {
        let path = self.file_path(params)?;
        let known = self.st.lock().unwrap().approved.contains(&path);
        if !path.starts_with(&self.root) && !known {
            self.allow(&path, "read").await?;
            // What is read is the file the person was shown, not another one the path leads to now.
            if self.file_path(params)? != path {
                return Err((-32000, NOT_ALLOWED.to_owned()));
            }
        }
        let text = tokio::task::spawn_blocking(move || read_text(&path))
            .await
            .map_err(|_| (-32000, "Could not read that file.".to_owned()))?
            .map_err(|what| (-32000, what.to_owned()))?;
        let first = params
            .get("line")
            .and_then(Value::as_u64)
            .map_or(0, |line| line.saturating_sub(1) as usize);
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .map_or(usize::MAX, |limit| limit as usize);
        let content: String = text.split_inclusive('\n').skip(first).take(limit).collect();
        Ok(json!({ "content": content }))
    }

    /// `fs/write_text_file`: always asked about, inside the folder too. What is written is the
    /// file the person was shown: the path is worked out again after the answer, and a path that
    /// has become another one (a link) is refused; a link is never followed in the opening.
    async fn write_file(&self, params: &Value) -> Result<Value, (i64, String)> {
        let path = self.file_path(params)?;
        let content = params
            .get("content")
            .and_then(Value::as_str)
            .ok_or((-32602, "No content.".to_owned()))?
            .to_owned();
        if content.len() as u64 > FILE_MAX {
            return Err((-32000, "That is too much to write.".to_owned()));
        }
        self.allow(&path, "edit").await?;
        if self.file_path(params)? != path {
            return Err((-32000, NOT_ALLOWED.to_owned()));
        }
        tokio::task::spawn_blocking(move || write_text(&path, &content))
            .await
            .map_err(|_| (-32000, "Could not write that file.".to_owned()))?
            .map_err(|_| (-32000, "Could not write that file.".to_owned()))?;
        Ok(Value::Null)
    }

    fn file_path(&self, params: &Value) -> Result<PathBuf, (i64, String)> {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty());
        let path = path.ok_or((-32602, "No path.".to_owned()))?;
        Ok(resolve(&self.root, path))
    }

    /// Asks about a file; `Err` unless the person allows it, and then the path is theirs for the turn.
    async fn allow(&self, path: &Path, kind: &str) -> Result<(), (i64, String)> {
        match self
            .ask(kind, None, &[path.to_string_lossy().into_owned()], None)
            .await
        {
            Decision::Allow => {
                self.st.lock().unwrap().approved.insert(path.to_path_buf());
                Ok(())
            }
            Decision::Refused => Err((-32000, UNSHOWN.to_owned())),
            _ => Err((-32000, NOT_ALLOWED.to_owned())),
        }
    }

    // --- one turn

    /// Sends the prompt and streams what comes back until the turn ends, then `done`.
    async fn run_turn(self: &Arc<Self>, input: String, reply: &Reply) {
        let (sink, mut frames) = mpsc::channel::<Value>(256);
        let lead = {
            let mut state = self.st.lock().unwrap();
            state.sink = Some(sink);
            state.approved.clear();
            state.approved_calls.clear();
            state.suspects.clear();
            state.violation = false;
            state.refused = 0;
            std::mem::take(&mut state.lead)
        };
        if !put(reply, json!({ "type": "started" })).await {
            self.st.lock().unwrap().lead = lead;
            return self.end_turn();
        }
        // Written before anything else is waited for, and not at all once the call is cancelled,
        // so no prompt can follow a cancel.
        if *reply.cancel.borrow() != 0 {
            self.st.lock().unwrap().lead = lead;
            self.turn_over();
            return self.end_turn();
        }
        let params = json!({ "sessionId": self.session_id(),
            "prompt": [{ "type": "text", "text": format!("{lead}{input}") }] });
        let (id, receive) = match self.begin("session/prompt", params).await {
            Ok(sent) => sent,
            Err(fail) => {
                failed(reply, &fail.message).await;
                self.turn_over();
                return self.end_turn();
            }
        };
        let prompt = self.finish("session/prompt", id, receive, None);
        tokio::pin!(prompt);
        let mut cancel = reply.cancel.clone();
        let mut beat = interval(self.shared.timing().heartbeat);
        beat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        beat.tick().await;
        let mut text = Text::default();
        enum End {
            /// A `failed` frame went out already (the agent left, or reached outside the folder).
            Failed,
            Prompt(Result<Value, Fail>),
            Cancelled,
        }
        let end = loop {
            let due = text.due();
            tokio::select! {
                biased;
                _ = cancelled(&mut cancel) => break End::Cancelled,
                Some(frame) = frames.recv() => match relay(reply, &mut text, frame).await {
                    Relayed::On => {}
                    Relayed::Final => break End::Failed,
                    Relayed::Gone => break End::Cancelled,
                },
                answer = &mut prompt => break End::Prompt(answer),
                () = async { match due { Some(at) => sleep_until(at).await, None => std::future::pending().await } } => {
                    if !text.flush(reply).await {
                        break End::Cancelled;
                    }
                }
                _ = beat.tick() => {
                    if !reply.send(json!({ "heartbeat": true })).await {
                        break End::Cancelled;
                    }
                }
            }
        };
        match end {
            End::Prompt(answer) => {
                // What the agent said before it ended the turn is already queued.
                let mut ended = false;
                while let Ok(frame) = frames.try_recv() {
                    match relay(reply, &mut text, frame).await {
                        Relayed::On => {}
                        Relayed::Final => ended = true,
                        Relayed::Gone => break,
                    }
                    if ended {
                        break;
                    }
                }
                if ended && self.violated() {
                    self.close();
                }
                if !ended && text.flush(reply).await {
                    let last = match &answer {
                        Ok(result) => match result.get("stopReason").and_then(Value::as_str) {
                            Some("end_turn" | "max_tokens" | "max_turn_requests") => {
                                json!({ "type": "done" })
                            }
                            Some("refusal") => {
                                failed_frame(&format!("{} refused to go on.", self.entry.name))
                            }
                            Some("cancelled") => {
                                failed_frame(&format!("{} stopped the turn.", self.entry.name))
                            }
                            other => failed_frame(&format!(
                                "{} ended the turn ({}).",
                                self.entry.name,
                                other.unwrap_or("unknown")
                            )),
                        },
                        Err(fail) => failed_frame(&fail.message),
                    };
                    if put(reply, last).await {
                        reply.send(json!({ "done": true })).await;
                    }
                } else if ended {
                    reply.send(json!({ "done": true })).await;
                }
            }
            End::Failed if self.violated() => {
                reply.send(json!({ "done": true })).await;
                self.stop_now().await;
            }
            End::Failed => {
                reply.send(json!({ "done": true })).await;
                self.wind_down(&mut prompt, &mut frames).await;
            }
            End::Cancelled => self.wind_down(&mut prompt, &mut frames).await,
        }
        self.turn_over();
        self.end_turn();
    }

    fn violated(&self) -> bool {
        self.st.lock().unwrap().violation
    }

    /// The agent is told to cancel, and the session ends without waiting for it.
    async fn stop_now(&self) {
        self.write(
            json!({ "method": "session/cancel", "params": { "sessionId": self.session_id() } }),
        )
        .await;
        self.close();
    }

    /// The agent is told to stop and given a moment to end the turn it was in (what it still says
    /// is dropped, but taken, so it never waits on us); one that does not end it is closed.
    /// Otherwise the session stays.
    async fn wind_down(
        &self,
        prompt: &mut (impl Future<Output = Result<Value, Fail>> + Unpin),
        frames: &mut mpsc::Receiver<Value>,
    ) {
        self.write(
            json!({ "method": "session/cancel", "params": { "sessionId": self.session_id() } }),
        )
        .await;
        self.turn_over();
        let wait = sleep(self.shared.timing().cancel);
        tokio::pin!(wait);
        let ended = loop {
            tokio::select! {
                _ = &mut *prompt => break true,
                Some(_) = frames.recv() => {}
                () = &mut wait => break false,
            }
        };
        if !ended {
            self.close();
        }
    }

    fn end_turn(&self) {
        let mut state = self.st.lock().unwrap();
        state.busy = false;
        state.sink = None;
        state.idle_since = Some(Instant::now());
    }

    /// Closes the session after `idle` without a turn.
    async fn watch_idle(self: Arc<Self>, idle: Duration) {
        let mut closed = self.closed.subscribe();
        loop {
            let wait = {
                let state = self.st.lock().unwrap();
                match (state.busy, state.idle_since) {
                    (false, Some(since)) => idle.saturating_sub(since.elapsed()),
                    _ => idle,
                }
            };
            if wait.is_zero() {
                return self.close();
            }
            tokio::select! {
                () = sleep(wait) => {}
                _ = closed.wait_for(|closed| *closed) => return,
            }
        }
    }

    /// Ends the process and what it started, the bridge and its folder, and everything that waits.
    /// The bot's folder stays.
    fn close(&self) {
        if self.closed.send_replace(true) {
            return;
        }
        kill(self.pid, &self.mark, true);
        let _ = std::fs::remove_dir_all(&self.bridge_dir);
        let mut sessions = self.shared.sessions.lock().unwrap();
        if sessions
            .get(&self.key)
            .is_some_and(|live| std::ptr::eq(Arc::as_ptr(live), self))
        {
            sessions.remove(&self.key);
        }
        drop(sessions);
        for (_, waiting) in self.waiting.lock().unwrap().drain() {
            let _ = waiting.send(Err(self.stopped()));
        }
        self.turn_over();
    }

    // --- the bridge to the bot's tools

    async fn accept(self: Arc<Self>, listener: UnixListener) {
        let mut closed = self.closed.subscribe();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { return };
                    tokio::spawn(self.clone().bridge(stream));
                }
                _ = closed.wait_for(|closed| *closed) => return,
            }
        }
    }

    /// One connection of the agent's MCP server: a key on every line, or it ends.
    async fn bridge(self: Arc<Self>, stream: UnixStream) {
        let (read, mut write) = stream.into_split();
        let mut read = BufReader::new(read);
        let mut closed = self.closed.subscribe();
        loop {
            let line = tokio::select! {
                line = read_line(&mut read) => line,
                _ = closed.wait_for(|closed| *closed) => return,
            };
            let Line::Text(line) = line else {
                return;
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                return;
            };
            let key = message.get("key").and_then(Value::as_str).unwrap_or("");
            if !same(key, &self.bridge_key) {
                return;
            }
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            let reply = match message.get("method").and_then(Value::as_str) {
                Some("list") => json!({ "id": id, "tools": self.st.lock().unwrap().tools }),
                Some("call") => {
                    let name = message.get("name").and_then(Value::as_str).unwrap_or("");
                    let args = message
                        .get("arguments")
                        .filter(|args| args.is_object())
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let (text, is_error) = self.tool_call(name, args).await;
                    json!({ "id": id, "text": text, "isError": is_error })
                }
                _ => return,
            };
            if write
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .is_err()
            {
                return;
            }
        }
    }

    /// One call of the bot's tool by the agent: out to the server as a frame, and back as the
    /// result of `agentToolResult`.
    async fn tool_call(&self, name: &str, args: Value) -> (String, bool) {
        let listed = self
            .st
            .lock()
            .unwrap()
            .tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == Some(name));
        if !listed {
            return (format!("There is no tool named {name}."), true);
        }
        if args.to_string().len() > TOOL_ARGS_MAX {
            return ("The arguments are too large.".to_owned(), true);
        }
        let mut over = self.epoch.subscribe();
        let first = *over.borrow_and_update();
        let mut closed = self.closed.subscribe();
        let (send, receive) = oneshot::channel();
        let call_id = {
            let mut state = self.st.lock().unwrap();
            if state.sink.is_none() {
                return ("The turn ended.".to_owned(), true);
            }
            state.calls += 1;
            let call_id = format!("c{}", state.calls);
            state.tool_waits.insert(call_id.clone(), send);
            call_id
        };
        self.emit(json!({ "type": "toolCall", "callId": call_id, "name": name, "args": args }))
            .await;
        let ended = ("The turn ended.".to_owned(), true);
        tokio::select! {
            result = receive => result.unwrap_or(ended),
            _ = over.wait_for(|epoch| *epoch != first) => ended,
            _ = closed.wait_for(|closed| *closed) => ended,
            () = sleep(self.shared.timing().tool) => {
                self.st.lock().unwrap().tool_waits.remove(&call_id);
                ("The tool did not answer in time.".to_owned(), true)
            }
        }
    }
}

/// Text frames of a turn are joined for a moment (a hundred milliseconds) and cut at sixteen
/// thousand characters, so the connection carries few and small frames.
#[derive(Default)]
struct Text {
    buffer: String,
    chars: usize,
    since: Option<Instant>,
}

impl Text {
    /// The pieces that are full.
    fn push(&mut self, more: &str) -> Vec<String> {
        let mut full = Vec::new();
        for character in more.chars() {
            if self.buffer.is_empty() {
                self.since = Some(Instant::now());
            }
            self.buffer.push(character);
            self.chars += 1;
            if self.chars == TEXT_PIECE {
                full.push(self.take());
            }
        }
        full
    }

    fn take(&mut self) -> String {
        self.chars = 0;
        self.since = None;
        std::mem::take(&mut self.buffer)
    }

    fn due(&self) -> Option<Instant> {
        self.since.map(|since| since + TEXT_FLUSH)
    }

    /// Sends what is held; false when the call is gone.
    async fn flush(&mut self, reply: &Reply) -> bool {
        self.buffer.is_empty() || put(reply, json!({ "type": "text", "text": self.take() })).await
    }
}

enum Relayed {
    On,
    /// A `failed` frame was sent: the turn is over.
    Final,
    Gone,
}

/// Sends one frame of the turn: text joins the buffer, anything else follows what came before.
async fn relay(reply: &Reply, text: &mut Text, frame: Value) -> Relayed {
    if frame.get("type").and_then(Value::as_str) == Some("text") {
        for piece in text.push(frame.get("text").and_then(Value::as_str).unwrap_or("")) {
            if !put(reply, json!({ "type": "text", "text": piece })).await {
                return Relayed::Gone;
            }
        }
        return Relayed::On;
    }
    let last = frame.get("type").and_then(Value::as_str) == Some("failed");
    if !text.flush(reply).await || !put(reply, frame).await {
        return Relayed::Gone;
    }
    if last { Relayed::Final } else { Relayed::On }
}

/// An ordinary file's text, at most `FILE_MAX` bytes of it. Opened without waiting and without
/// following a link, so a pipe or a link put there since is refused, never waited on.
fn read_text(path: &Path) -> Result<String, &'static str> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "Could not read that file.")?;
    if !file.metadata().is_ok_and(|meta| meta.is_file()) {
        return Err("That is not a file.");
    }
    let mut bytes = Vec::new();
    file.take(FILE_MAX + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read that file.")?;
    if bytes.len() as u64 > FILE_MAX {
        return Err("That file is too large.");
    }
    String::from_utf8(bytes).map_err(|_| "That file is not text.")
}

fn write_text(path: &Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(content.as_bytes())
}

/// What a permission request is about: its kind, and what it names.
fn approval(call: &Value) -> (&'static str, Option<String>, Vec<String>, Option<Value>) {
    const KINDS: [&str; 10] = [
        "read",
        "edit",
        "delete",
        "move",
        "search",
        "execute",
        "think",
        "fetch",
        "switch_mode",
        "other",
    ];
    let kind = call
        .get("kind")
        .and_then(Value::as_str)
        .and_then(|kind| KINDS.iter().find(|known| **known == kind).copied())
        .unwrap_or("other");
    (
        kind,
        call.get("title").and_then(Value::as_str).map(str::to_owned),
        paths_of(call),
        call.get("rawInput").cloned(),
    )
}

/// The question's first line: the server hears it in English, the dialog speaks the person's.
fn asks(name: &str, kind: &str, turkish: bool) -> String {
    if turkish {
        format!("{name} devam etmeden önce soruyor ({kind}).")
    } else {
        format!("{name} asks before it goes on ({kind}).")
    }
}

/// The places a tool call names.
fn paths_of(call: &Value) -> Vec<String> {
    call.get("locations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|place| place.get("path").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

/// Where `path` really is: relative to `root` when it is not absolute, `..` and every link
/// followed, a link that leads nowhere (yet) included, so one out of the folder reads as outside.
fn resolve(root: &Path, path: &str) -> PathBuf {
    use std::ffi::OsString;
    let path = Path::new(path);
    let mut resolved = if path.is_absolute() {
        PathBuf::from("/")
    } else {
        root.to_path_buf()
    };
    let names = |path: &Path| -> Vec<OsString> {
        path.components()
            .rev()
            .filter_map(|component| match component {
                Component::Normal(name) => Some(name.to_owned()),
                Component::ParentDir => Some("..".into()),
                _ => None,
            })
            .collect()
    };
    let mut todo = names(path);
    let mut links = 0;
    while let Some(name) = todo.pop() {
        if name == ".." {
            resolved.pop();
            continue;
        }
        resolved.push(&name);
        let Ok(meta) = std::fs::symlink_metadata(&resolved) else {
            continue;
        };
        if !meta.is_symlink() {
            continue;
        }
        links += 1;
        // Too many links to follow: somewhere that is never inside.
        let Ok(target) = std::fs::read_link(&resolved).map(Some).or(Err(())) else {
            continue;
        };
        let target = target.unwrap_or_default();
        if links > 40 {
            return PathBuf::from("/dozo-too-many-links");
        }
        resolved.pop();
        if target.is_absolute() {
            resolved = PathBuf::from("/");
        }
        todo.extend(names(&target));
    }
    resolved
}

/// The bot's instructions as the first prompt carries them; the protocol has no other place.
fn lead(instructions: &str) -> String {
    let instructions = instructions.trim();
    if instructions.is_empty() {
        String::new()
    } else {
        format!("Instructions:\n{instructions}\n\n")
    }
}

fn create_private(folder: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(folder)
}

/// `bytes` random bytes as hex, or `None` when the system's source fails: never a weak key.
fn hex_from(bytes: usize, fill: impl FnOnce(&mut [u8]) -> bool) -> Option<String> {
    let mut random = vec![0u8; bytes];
    fill(&mut random).then(|| random.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn random_hex(bytes: usize) -> Option<String> {
    hex_from(bytes, |random| getrandom::fill(random).is_ok())
}

/// What the person is told when a question they may still see open was refused for lack of an
/// answer.
pub fn ended_text(turkish: bool) -> &'static str {
    if turkish {
        "Bir soru yanıtınız olmadan bitti, bu yüzden reddedildi. Üzerindeki İzin Ver ya da İptal artık bir şey yapmaz."
    } else {
        "A question ended without your answer, so it was refused. Allow or Cancel on it no longer does anything."
    }
}

/// The question as the dialog shows it: what the agent will do, then what it names. Each part is
/// cut on its own, so a long one cannot push the others out, and says so with an ellipsis.
fn dialog_text(
    summary: &str,
    title: Option<&str>,
    paths: &[String],
    input: Option<&Value>,
) -> Option<String> {
    let joined = paths.join("\n");
    let rendered = input.map(Value::to_string);
    let unsafe_part = unsafe_text(summary)
        || title.is_some_and(unsafe_text)
        || paths.iter().any(|path| unsafe_text(path))
        || input.is_some_and(unsafe_value);
    let too_long = len16(summary) > 300
        || title.is_some_and(|title| len16(title) > 300)
        || len16(&joined) > 600
        || rendered.as_ref().is_some_and(|input| len16(input) > 800);
    if unsafe_part || too_long {
        return None;
    }
    let mut parts = vec![summary.to_owned()];
    parts.extend(title.map(str::to_owned));
    if !paths.is_empty() {
        parts.push(joined);
    }
    parts.extend(rendered);
    let text = parts.join("\n\n");
    (len16(&text) <= DIALOG_MAX).then_some(text)
}

/// A line break or any other control character, or a character that changes the direction text
/// runs in: what the person reads could then differ from what the agent will do.
fn unsafe_char(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{2028}'
                | '\u{2029}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2066}'..='\u{2069}'
                | '\u{200E}'
                | '\u{200F}'
                | '\u{61C}'
        )
}

fn unsafe_text(text: &str) -> bool {
    text.chars().any(unsafe_char)
}

/// Any text inside the value, names included.
fn unsafe_value(value: &Value) -> bool {
    match value {
        Value::String(text) => unsafe_text(text),
        Value::Array(items) => items.iter().any(unsafe_value),
        Value::Object(fields) => fields
            .iter()
            .any(|(name, value)| unsafe_text(name) || unsafe_value(value)),
        _ => false,
    }
}

/// Compared without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0, |different, (x, y)| different | (x ^ y))
            == 0
}

enum Line {
    Text(String),
    End,
    TooLong,
}

/// One line of at most `LINE_MAX` bytes.
async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Line {
    let mut line = Vec::new();
    loop {
        let Ok(chunk) = reader.fill_buf().await else {
            return Line::End;
        };
        if chunk.is_empty() {
            return Line::End;
        }
        match chunk.iter().position(|byte| *byte == b'\n') {
            Some(end) => {
                line.extend_from_slice(&chunk[..end]);
                reader.consume(end + 1);
                return if line.len() <= LINE_MAX {
                    Line::Text(String::from_utf8_lossy(&line).into_owned())
                } else {
                    Line::TooLong
                };
            }
            None => {
                line.extend_from_slice(chunk);
                let taken = chunk.len();
                reader.consume(taken);
                if line.len() > LINE_MAX {
                    return Line::TooLong;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The person's side: the switch, its consent and the questions.

/// The words of the switch and its consent, in English or Turkish like the menus (`words.rs`).
pub struct Words {
    pub menu: String,
    pub allow: &'static str,
    pub cancel: &'static str,
    pub consent: String,
}

/// The two buttons of a question: allow, and cancel.
fn buttons(turkish: bool) -> (&'static str, &'static str) {
    if turkish {
        ("İzin Ver", "İptal")
    } else {
        ("Allow", "Cancel")
    }
}

pub fn words(entry: &Entry, turkish: bool) -> Words {
    let name = entry.name;
    let risk = |said: &str| {
        if said.is_empty() {
            String::new()
        } else {
            format!(" {said}")
        }
    };
    if turkish {
        return Words {
            menu: format!("Botlar Burada {name} Kullansın"),
            allow: buttons(true).0,
            cancel: buttons(true).1,
            consent: format!(
                "Bir bot bu bilgisayarda {name}'yi {name} hesabınızla çalıştırabilir. {name} yazmadan, program çalıştırmadan ya da botun klasörü dışına çıkmadan önce burada sorar.{}",
                risk(entry.terms.as_ref().map_or("", |terms| terms.tr)),
            ),
        };
    }
    Words {
        menu: format!("Let Bots Use {name} Here"),
        allow: buttons(false).0,
        cancel: buttons(false).1,
        consent: format!(
            "A bot can run {name} on this computer with your {name} account. {name} asks you here before it writes, runs a program or reaches outside the bot's folder.{}",
            risk(entry.terms.as_ref().map_or("", |terms| terms.en)),
        ),
    }
}

/// The menu item's id for an agent.
pub const MENU_PREFIX: &str = "agent:";

pub use dialogs::{attach, clicked, sync_menu};

mod dialogs {
    use super::*;
    use tauri::menu::{CheckMenuItem, MenuItemKind};
    use tauri::{AppHandle, Manager};
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    /// The person's questions, as small system dialogs of this app (`browser_signin.rs` does the same
    /// for a sign-in).
    struct Dialogs(AppHandle);

    impl Approvals for Dialogs {
        fn ask(&self, text: &str) -> oneshot::Receiver<bool> {
            let (answer, answered) = oneshot::channel();
            let (allow, cancel) = buttons(crate::words::turkish());
            self.0
                .dialog()
                .message(text)
                .title("Dozo")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    allow.to_owned(),
                    cancel.to_owned(),
                ))
                .show(move |allowed| {
                    let _ = answer.send(allowed);
                });
            answered
        }

        fn ended(&self, _text: &str) {
            self.0
                .dialog()
                .message(ended_text(crate::words::turkish()))
                .title("Dozo")
                .show(|_| {});
        }
    }

    /// Wires the runner of the app to the dialogs and to what the person allowed.
    pub fn attach(runner: &Runner, app: &AppHandle) {
        let agents = runner.agents();
        agents.set_approvals(Arc::new(Dialogs(app.clone())));
        if let Ok(folder) = app.path().app_config_dir() {
            agents.set_config(folder.join("agents.json"));
        }
    }

    fn runner(app: &AppHandle) -> Option<Arc<Runner>> {
        Some(app.try_state::<crate::device::Access>()?.runner().clone())
    }

    /// One switch per agent found on the person's `PATH`, after the one of this computer; it goes
    /// when the agent does, and its mark is what the person allowed.
    pub fn sync_menu(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let Some(runner) = runner(&app) else { return };
            let agents = runner.agents();
            let found = agents.found().await;
            let Some(MenuItemKind::Submenu(menu)) =
                app.menu().and_then(|menu| menu.get(crate::MENU_ID))
            else {
                return;
            };
            let turkish = crate::words::turkish();
            for entry in agents.catalog() {
                let id = format!("{MENU_PREFIX}{}", entry.id);
                let here = found.iter().any(|found| found.id == entry.id);
                match (here, menu.get(&id)) {
                    (true, Some(MenuItemKind::Check(item))) => {
                        let _ = item.set_checked(agents.enabled(entry.id));
                    }
                    (true, None) => {
                        let label = words(entry, turkish).menu;
                        let Ok(item) = CheckMenuItem::with_id(
                            &app,
                            &id,
                            label,
                            true,
                            agents.enabled(entry.id),
                            None::<&str>,
                        ) else {
                            continue;
                        };
                        let after = menu.items().ok().and_then(|items| {
                            items
                                .iter()
                                .position(|item| item.id().as_ref() == crate::device::MENU_ID)
                        });
                        let _ = match after {
                            Some(at) => menu.insert(&item, at + 1),
                            None => menu.append(&item),
                        };
                    }
                    (false, Some(item)) => {
                        let _ = menu.remove(&item);
                    }
                    _ => {}
                }
            }
            crate::prefs::changed(&app);
        });
    }

    /// The agent's switch was clicked: off at once, on after the person has agreed to what it
    /// means. The server's connection is made again, so the server learns what is offered.
    pub fn clicked(app: &AppHandle, id: &str) {
        let Some(runner) = runner(app) else { return };
        let Some(entry) = id.strip_prefix(MENU_PREFIX).and_then(|id| {
            runner
                .agents()
                .catalog()
                .iter()
                .find(|entry| entry.id == id)
        }) else {
            return;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let agents = runner.agents();
            if agents.enabled(entry.id) {
                agents.set_enabled(entry.id, false);
            } else {
                let words = words(entry, crate::words::turkish());
                let mut dialog = app
                    .dialog()
                    .message(words.consent)
                    .title(words.menu)
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        words.allow.to_owned(),
                        words.cancel.to_owned(),
                    ));
                if let Some(window) = app.get_webview_window("main") {
                    dialog = dialog.parent(&window);
                }
                let allowed = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
                    .await
                    .unwrap_or(false);
                if allowed {
                    agents.set_enabled(entry.id, true);
                }
            }
            sync_menu(&app);
            crate::device::reconnect(&app);
        });
    }
}

#[cfg(test)]
#[path = "device_agent_tests.rs"]
mod tests;
