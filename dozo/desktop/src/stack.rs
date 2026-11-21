//! The server on this computer: installs it from the manifest on first use, then starts it in the
//! order and with the variables of `dozo/server-bundle/README.md` ("Start contract"): Postgres,
//! the migrations, then the API, the worker and the web server, ready once the API's `/health`
//! and the web page answer. It stops in reverse. What the window shows is `Status`.
//!
//! Its folder (`<app local data>/local-server`, `FOLDER`):
//! - `versions/<version>/{node,postgres,server}`: what was installed, and `current`, its name
//! - `pgdata/`: the database; `data/`: the server's files (`DATA_DIR`)
//! - `secrets` (this user only), `ports`, `stack.lock`, `db-created`
//! - `downloads/`: parts on their way, kept to go on after a failed try; `logs/`, `run/`

use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::stack_fetch::{self, FetchError, Format};
use crate::stack_manifest::{self, Part, Release};
use crate::stack_os::Stop;
use crate::stack_proc::{self, Backoff, Launch, OnLine, Spec, Supervisor};
use crate::stack_setup::{self, PortError, Ports, Secrets};
use crate::stack_update;
use std::io;

/// The manifest of the server this app was built for. A build can name another
/// (`DOZO_SERVER_MANIFEST` at compile time), and so can the environment at run time, for tests
/// and development: an `https://`, `http://` or `file://` address, or a file's path.
const MANIFEST: &str = match option_env!("DOZO_SERVER_MANIFEST") {
    Some(manifest) => manifest,
    None => {
        "https://github.com/SSilistre-dev/dozo/releases/download/server-v0.11.0-5/manifest.json"
    }
};

/// The server version this app expects: the one `MANIFEST` names. An installed older one is
/// updated to it at the next start (`stack_update.rs`); when it is already installed, no manifest
/// is read.
const SERVER_VERSION: &str = "0.11.0-5";

/// Where the server on this computer sends in-app feedback to (`apps/api/src/dozo-feedback.ts`),
/// named by the build (`DOZO_FEEDBACK_EMAIL`); without it the feedback is only kept.
const FEEDBACK_EMAIL: Option<&str> = option_env!("DOZO_FEEDBACK_EMAIL");

/// The relay a phone reaches this computer through (`dozo/relay/agent/README.md`). A build can
/// name another (`DOZO_RELAY_URL`), and so can the environment or the settings file (`relay=`).
pub const RELAY: &str = match option_env!("DOZO_RELAY_URL") {
    Some(relay) => relay,
    None => "https://relay.dozo.bot",
};

const LOG_MAX: u64 = 5 << 20;

#[derive(Clone, Debug)]
pub struct Options {
    pub manifest: String,
    pub hosted_login_issuer: Option<String>,
    pub relay: String,
    /// The version the manifest names, when known without reading it (the build's own).
    pub expected: Option<String>,
}

impl Options {
    pub fn from_build_and_environment() -> Options {
        // Sign-in with the hosted account (`server::hosted_login_issuer`): its origin, as the
        // server's `HOSTED_LOGIN_ISSUER` wants it, without a path.
        let issuer = crate::server::hosted_login_issuer()
            .map(|issuer| issuer.as_str().trim_end_matches('/').to_owned());
        Options {
            manifest: std::env::var("DOZO_SERVER_MANIFEST").unwrap_or_else(|_| MANIFEST.into()),
            hosted_login_issuer: issuer,
            relay: std::env::var("DOZO_RELAY_URL").unwrap_or_else(|_| RELAY.into()),
            // Another manifest may name any version: it is read to know.
            expected: (option_env!("DOZO_SERVER_MANIFEST").is_none()
                && std::env::var_os("DOZO_SERVER_MANIFEST").is_none())
            .then(|| SERVER_VERSION.to_owned()),
        }
    }
}

/// What the window shows while the server is set up, as one line.
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Off,
    Downloading(u8),
    Preparing,
    /// Moving the installed server to a newer version: its data is copied, then it migrates.
    Updating,
    Starting,
    /// The web address, as the app saves a server.
    Ready(String),
    Failed(Failure),
}

impl Status {
    /// What the local screen reads (`ui/local.js`).
    pub fn to_json(&self) -> Value {
        match self {
            Status::Off => json!({ "state": "off" }),
            Status::Downloading(percent) => json!({ "state": "downloading", "percent": percent }),
            Status::Preparing => json!({ "state": "preparing" }),
            Status::Updating => json!({ "state": "updating" }),
            Status::Starting => json!({ "state": "starting" }),
            Status::Ready(url) => json!({ "state": "ready", "url": url }),
            Status::Failed(failure) => json!({ "state": "failed", "message": failure.message() }),
        }
    }
}

/// Why the server is not running, as the one sentence the window shows. The details are in
/// `logs/manager.log`.
#[derive(Clone, Debug, PartialEq)]
pub enum Failure {
    AlreadyRunning,
    NoLibssl,
    Download,
    WebPortTaken(u16),
    Unsupported,
    Start,
    /// The newer version did not start; the previous one and its data are back.
    UpdateRolledBack,
}

impl Failure {
    pub fn message(&self) -> String {
        match self {
            Failure::AlreadyRunning => {
                "Another Dozo is already running the server on this computer.".into()
            }
            Failure::NoLibssl => "This computer needs libssl3 (OpenSSL 3).".into(),
            Failure::Download => "Could not download the server. Check the connection.".into(),
            Failure::WebPortTaken(port) => {
                format!("Port {port} on this computer is in use by another program.")
            }
            Failure::Unsupported => "The server can't run on this computer yet.".into(),
            Failure::Start => "The server on this computer did not start.".into(),
            Failure::UpdateRolledBack => {
                "The update did not start, so the server is back as it was.".into()
            }
        }
    }
}

/// The server's folder in the app's local data folder. On macOS that is also the config folder,
/// where the settings file is `server` (`settings::FILE`): the two never share a name.
pub const FOLDER: &str = "local-server";

/// The name the folder had before; only a Linux or Windows build could have made it there.
const OLD_FOLDER: &str = "server";

/// The server's folder in `data`, the app's local data folder. A folder left under the old name
/// moves once, in one rename, unless the new one exists; a file of that name (the settings, on
/// macOS) is never touched.
pub fn folder_in(data: &Path) -> PathBuf {
    let folder = data.join(FOLDER);
    let old = data.join(OLD_FOLDER);
    if old.is_dir()
        && !folder.exists()
        && let Err(error) = fs::rename(&old, &folder)
    {
        eprintln!("dozo: could not move the server's folder: {error}");
    }
    folder
}

/// The folder and the names in it.
#[derive(Clone, Debug)]
pub struct Layout(pub PathBuf);

impl Layout {
    fn at(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn version(&self, version: &str) -> PathBuf {
        self.at("versions").join(version)
    }
}

/// Is the server ready: asked again and again while it starts. Real checks below; tests stand in.
pub trait Checks: Send + Sync + 'static {
    fn postgres(&self, bin: &Path, port: u16) -> bool;
    fn server(&self, ports: Ports) -> bool;
}

pub struct RealChecks;

impl Checks for RealChecks {
    fn postgres(&self, bin: &Path, port: u16) -> bool {
        let mut command = std::process::Command::new(bin.join(exe("pg_isready")));
        command
            .args(["-q", "-t", "2", "-h", "127.0.0.1", "-p", &port.to_string()])
            .env_clear();
        // Windows opens no socket without it.
        if let Some(root) = std::env::var_os("SystemRoot").filter(|_| cfg!(windows)) {
            command.env("SystemRoot", root);
        }
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        command.status().is_ok_and(|status| status.success())
    }

    fn server(&self, ports: Ports) -> bool {
        answers_200(ports.api, "/health") && answers_200(ports.web, "/")
    }
}

/// An HTTP GET on 127.0.0.1 whose answer is 200.
pub fn answers_200(port: u16, path: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect((Ipv4Addr::LOCALHOST, port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    let mut head = [0u8; 12];
    stream.write_all(request.as_bytes()).is_ok()
        && stream.read_exact(&mut head).is_ok()
        && head.starts_with(b"HTTP/1.")
        && &head[9..12] == b"200"
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

#[derive(Default)]
struct Running {
    task: Option<JoinHandle<()>>,
    supervisor: Supervisor,
    lock: Option<Arc<fs::File>>,
    agent: Option<Agent>,
}

/// The server on this computer, as the app holds it. One start or stop at a time.
pub struct Local {
    status: watch::Sender<Status>,
    running: tokio::sync::Mutex<Running>,
    checks: Arc<dyn Checks>,
    backoff: Backoff,
    /// The relay agent's last word about a phone: `paired`, then `approval` (its platform and the
    /// code to compare) until the person allows it here (`Agent::approve`), `approved`, or
    /// `expired` when nobody did within 5 minutes.
    phone_event: watch::Sender<Option<Value>>,
    /// How far this start took an update: 0 none, 1 the new version made current, 2 it was
    /// started. Only a start that failed after 1 is undone, and only after 2 is that version
    /// skipped from then on (`undo_update`).
    update_stage: std::sync::atomic::AtomicU8,
}

impl Local {
    pub fn new(checks: Arc<dyn Checks>) -> Arc<Local> {
        Arc::new(Local {
            status: watch::channel(Status::Off).0,
            running: tokio::sync::Mutex::new(Running::default()),
            checks,
            backoff: Backoff::new(
                Duration::from_secs(1),
                Duration::from_secs(30),
                Duration::from_secs(60),
            ),
            phone_event: watch::channel(None).0,
            update_stage: std::sync::atomic::AtomicU8::new(0),
        })
    }

    /// The relay agent of the running server, if its bundle has one.
    pub async fn agent(&self) -> Option<Agent> {
        self.running.lock().await.agent.clone()
    }

    /// Changes with each `paired`, `approval`, `approved` or `expired` line of the relay agent.
    pub fn phone_events(&self) -> watch::Receiver<Option<Value>> {
        self.phone_event.subscribe()
    }

    pub fn status(&self) -> watch::Receiver<Status> {
        self.status.subscribe()
    }

    /// Nothing is running or starting: there is nothing to stop.
    pub fn idle(&self) -> bool {
        matches!(*self.status.borrow(), Status::Off | Status::Failed(_))
    }

    /// Starts the server, unless it is starting or running already. After a failure it starts
    /// again from the beginning, keeping what was downloaded.
    pub async fn start(self: &Arc<Self>, layout: Layout, options: Options) {
        let mut running = self.running.lock().await;
        if running
            .task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
            || matches!(*self.status.borrow(), Status::Ready(_))
        {
            return;
        }
        self.status.send_replace(Status::Starting);
        let local = self.clone();
        running.task = Some(tokio::spawn(async move {
            let result = local.bring_up(&layout, &options).await;
            match result {
                Ok(url) => {
                    local.status.send_replace(Status::Ready(url));
                }
                Err(failure) => {
                    local.release().await;
                    // An update that did not start: back to the version and data before it.
                    let failure = match local.undo_update(&layout) {
                        Some(failure) => failure,
                        None => failure,
                    };
                    local.status.send_replace(Status::Failed(failure));
                }
            }
        }));
    }

    /// Stops the server and everything it started; true when all stopped when asked. Holds the
    /// lock throughout, so a start asked for meanwhile comes after it.
    pub async fn stop(&self) -> bool {
        let mut running = self.running.lock().await;
        if let Some(task) = running.task.take() {
            task.abort();
            let _ = task.await;
        }
        let clean = running.supervisor.stop_all().await;
        running.lock = None;
        running.agent = None;
        self.status.send_replace(Status::Off);
        clean
    }

    async fn release(&self) -> bool {
        let mut running = self.running.lock().await;
        let clean = running.supervisor.stop_all().await;
        running.lock = None;
        running.agent = None;
        clean
    }

    async fn bring_up(&self, layout: &Layout, options: &Options) -> Result<String, Failure> {
        self.update_stage
            .store(0, std::sync::atomic::Ordering::SeqCst);
        for folder in ["versions", "downloads", "logs", "data", "run"] {
            fs::create_dir_all(layout.at(folder)).map_err(|_| Failure::Start)?;
        }
        let lock = take_lock(&layout.at("stack.lock")).await?;
        let lock = Arc::new(lock);
        self.running.lock().await.lock = Some(lock.clone());
        let logs = layout.at("logs");
        let launch = Arc::new(Launch {
            events: stack_proc::events_log(&logs, LOG_MAX),
            logs,
            run: layout.at("run"),
            lock: Some(lock),
            backoff: self.backoff.clone(),
            log_max: LOG_MAX,
        });
        let failed = |failure: Failure, why: &str| {
            launch.note(&format!("start failed: {why}"));
            failure
        };
        // Where nothing ended them with a crashed app (macOS), what it left still runs: holding
        // the ports and the database. It ends first, before anything is started.
        let versions = layout.at("versions");
        let leftovers = {
            let launch = launch.clone();
            tokio::task::spawn_blocking(move || stack_proc::end_leftovers(&launch, &versions))
        };
        let _ = leftovers.await;
        if !stack_setup::has_libssl3() {
            return Err(failed(Failure::NoLibssl, "no libssl.so.3"));
        }
        // A restore cut off last time (Back Up and Restore) is undone first.
        match crate::stack_backup::recover_restore(&layout.0) {
            Ok(true) => launch.note("a restore did not finish: the data before it is back"),
            Ok(false) => {}
            Err(error) => return Err(failed(Failure::Start, &format!("restore: {error}"))),
        }
        // An update cut off last time (the app ended, the disk filled) is undone first.
        match stack_update::recover(&layout.0) {
            Ok(stack_update::Recovered::RolledBack { from, to }) => {
                launch.note(&format!("an update to {to} did not finish: back on {from}"));
            }
            Ok(_) => {}
            Err(error) => return Err(failed(Failure::Start, &format!("update: {error}"))),
        }
        let version = match installed(layout) {
            Some(current) => self.update(layout, options, &current, &launch).await,
            None => self
                .install(layout, options)
                .await
                .map_err(|(failure, why)| failed(failure, &why))?,
        };
        self.status.send_replace(Status::Starting);
        let secrets = stack_setup::secrets(&layout.at("secrets"))
            .map_err(|error| failed(Failure::Start, &format!("secrets: {error}")))?;
        let ports = stack_setup::ports(&layout.at("ports")).map_err(|error| match error {
            PortError::WebTaken(port) => failed(Failure::WebPortTaken(port), "web port taken"),
            PortError::Io(error) => failed(Failure::Start, &format!("ports: {error}")),
        })?;
        let mut plan = Plan::new(layout, &version, ports, &secrets, options)
            .map_err(|why| failed(Failure::Start, &why))?;
        plan.user = tokio::task::spawn_blocking(stack_setup::user_environment)
            .await
            .unwrap_or_default();
        // From here a failure is the new version's own, when this start updated.
        let _ = self.update_stage.compare_exchange(
            1,
            2,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        );
        self.run(&plan, layout, &launch)
            .await
            .map_err(|why| failed(Failure::Start, &why))?;
        // The phone link. A bundle without the agent (older) runs without it.
        if let Some(agent) = plan.agent(layout, options, &launch) {
            let phone_event = self.phone_event.clone();
            let mut run = agent.spec("run", &["--origin", &plan.web]);
            run.on_line = Some(OnLine(Arc::new(move |line| {
                if let Some(event) = phone_event_of(line) {
                    phone_event.send_if_modified(|last| keep_phone_event(last, event));
                }
            })));
            self.keep(run, &launch)
                .await
                .map_err(|why| failed(Failure::Start, &why))?;
            self.running.lock().await.agent = Some(agent);
        }
        if let Some(journal) = stack_update::journal(&layout.0) {
            stack_update::finish(&layout.0)
                .map_err(|error| failed(Failure::Start, &format!("update: {error}")))?;
            launch.note(&format!("updated from {} to {}", journal.from, journal.to));
        }
        launch.note(&format!("ready at {}", plan.web));
        Ok(format!("{}/", plan.web))
    }

    /// Downloads the three parts (one percentage over all of them), unpacks them into
    /// `versions/<version>` and records it as `current`. A part unpacked by an earlier try is
    /// neither downloaded nor unpacked again.
    async fn install(
        &self,
        layout: &Layout,
        options: &Options,
    ) -> Result<String, (Failure, String)> {
        self.status.send_replace(Status::Downloading(0));
        let release = fetch_release(options).await?;
        self.install_release(layout, &release).await
    }

    /// Installs `release` into `versions/<version>`, beside any other, and makes it `current`
    /// only once it is all there.
    async fn install_release(
        &self,
        layout: &Layout,
        release: &Release,
    ) -> Result<String, (Failure, String)> {
        self.progress(Status::Downloading(0));
        let target = layout.version(&release.version);
        let mut partial = target.as_os_str().to_owned();
        partial.push(".partial");
        let partial = PathBuf::from(partial);
        let mut parts = Vec::new();
        for (name, part, strip) in [
            ("node", &release.node, true),
            ("postgres", &release.postgres, true),
            ("server", &release.server, false),
        ] {
            let format = Format::of(&part.url)
                .ok_or_else(|| (Failure::Unsupported, format!("{name}: unknown archive")))?;
            let done = partial.join(name).exists();
            parts.push((name, part, format, strip, done));
        }
        let files = self.download_all(&parts, layout).await?;
        self.progress(Status::Preparing);
        let jobs: Vec<(PathBuf, PathBuf, Format, bool)> = parts
            .iter()
            .zip(files)
            .filter_map(|((name, _, format, strip, _), file)| {
                Some((file?, partial.join(name), *format, *strip))
            })
            .collect();
        let into = partial.clone();
        let unpacked = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            // A stopped start cannot cancel this job: the next one waits for it to end.
            static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
            let _turn = ONE_AT_A_TIME
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            fs::create_dir_all(&into)?;
            for (file, target, format, strip) in jobs {
                if !target.exists() {
                    stack_fetch::unpack(&file, format, &target, strip)?;
                }
                fs::remove_file(&file)?;
            }
            stack_setup::fit_postgres(&into.join("postgres")).map_err(std::io::Error::other)
        })
        .await
        .map_err(|error| (Failure::Start, error.to_string()))?;
        unpacked.map_err(|error| (Failure::Start, format!("unpack: {error}")))?;
        if target.exists() {
            fs::remove_dir_all(&target).map_err(|error| (Failure::Start, error.to_string()))?;
        }
        fs::rename(&partial, &target)
            .map_err(|error| (Failure::Start, format!("install: {error}")))?;
        // A bundle built on Windows lists its links; a junction holds its target's full path, so
        // they are made only now that the bundle is where it stays. Should that fail, the next
        // start installs again.
        let server = target.join("server/rakazo-server");
        let root = layout.0.clone();
        let version = release.version.clone();
        let linked = tokio::task::spawn_blocking(move || stack_fetch::make_links(&server))
            .await
            .map_err(std::io::Error::other)
            .and_then(|made| made)
            .and_then(|_| stack_update::set_current(&root, &version));
        if let Err(error) = linked {
            let _ = fs::remove_dir_all(&target);
            return Err((Failure::Start, format!("install: links: {error}")));
        }
        Ok(release.version.clone())
    }

    /// The version to start: `current`, or the newer one the manifest names, installed beside it
    /// after its data was copied (`stack_update::begin`). Anything that goes wrong before the new
    /// version is current (no network, a full disk) leaves `current` to start as before.
    async fn update(
        &self,
        layout: &Layout,
        options: &Options,
        current: &str,
        launch: &Launch,
    ) -> String {
        let root = &layout.0;
        let skipped = stack_update::skipped(root);
        if options.expected.as_deref() == Some(current)
            || (options.expected.is_some() && skipped == options.expected)
        {
            return current.to_owned();
        }
        let release = match fetch_release(options).await {
            Ok(release) => release,
            Err((_, why)) => {
                launch.note(&format!("update: no manifest, starting {current}: {why}"));
                return current.to_owned();
            }
        };
        match stack_update::compare(&release.version, current) {
            Some(std::cmp::Ordering::Greater) if skipped.as_deref() != Some(&release.version) => {}
            Some(std::cmp::Ordering::Less) => {
                launch.note(&format!(
                    "update: the manifest names {}, older than {current}: not going back",
                    release.version
                ));
                return current.to_owned();
            }
            _ => return current.to_owned(),
        }
        self.status.send_replace(Status::Updating);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        let begun = tokio::task::spawn_blocking({
            let (root, from, to) = (root.clone(), current.to_owned(), release.version.clone());
            move || stack_update::begin(&root, &from, &to, stamp)
        })
        .await
        .map_err(io::Error::other)
        .and_then(|begun| begun);
        if let Err(error) = begun {
            launch.note(&format!(
                "update: copying the data failed, starting {current}: {error}"
            ));
            return current.to_owned();
        }
        launch.note(&format!("updating from {current} to {}", release.version));
        match self.install_release(layout, &release).await {
            Ok(version) => {
                self.update_stage
                    .store(1, std::sync::atomic::Ordering::SeqCst);
                version
            }
            Err((_, why)) => {
                // Not current yet: the data was not touched, the copy just goes unused.
                let _ = stack_update::recover(root);
                launch.note(&format!(
                    "update: installing failed, starting {current}: {why}"
                ));
                current.to_owned()
            }
        }
    }

    /// Shows an install step, unless an update is under way: that says "Updating" throughout.
    fn progress(&self, step: Status) {
        self.status.send_if_modified(|status| {
            let shown = *status != Status::Updating && *status != step;
            if shown {
                *status = step;
            }
            shown
        });
    }

    /// After a start that failed: when it was an update, the version and data before it come
    /// back, and that version is not tried again on its own.
    /// A start that failed for another reason (the folder held, a port taken before the new
    /// version ran) undoes nothing and skips nothing: the next start finds the journal and decides.
    fn undo_update(&self, layout: &Layout) -> Option<Failure> {
        let stage = self
            .update_stage
            .swap(0, std::sync::atomic::Ordering::SeqCst);
        if stage == 0 {
            return None;
        }
        match stack_update::recover(&layout.0) {
            Ok(stack_update::Recovered::RolledBack { to, .. }) if stage == 2 => {
                let _ = stack_update::skip(&layout.0, &to);
                Some(Failure::UpdateRolledBack)
            }
            _ => None,
        }
    }

    /// The parts not unpacked yet, downloaded; `None` for the others.
    async fn download_all(
        &self,
        parts: &[(&str, &Part, Format, bool, bool)],
        layout: &Layout,
    ) -> Result<Vec<Option<PathBuf>>, (Failure, String)> {
        let total: u64 = parts.iter().map(|part| part.1.size).sum();
        let done = Arc::new(Mutex::new(vec![0u64; parts.len()]));
        let mut files = Vec::new();
        for (index, (_, part, _, _, unpacked)) in parts.iter().enumerate() {
            let done = done.clone();
            let status = self.status.clone();
            let mut arrived = move |bytes: u64| {
                let mut done = done.lock().unwrap();
                done[index] = bytes;
                let percent = (done.iter().sum::<u64>() * 100 / total.max(1)).min(100) as u8;
                status.send_if_modified(|status| {
                    // An update says so throughout instead.
                    if *status == Status::Updating {
                        return false;
                    }
                    let changed = *status != Status::Downloading(percent);
                    *status = Status::Downloading(percent);
                    changed
                });
            };
            if *unpacked {
                arrived(part.size);
                files.push(None);
                continue;
            }
            let file = stack_fetch::download(part, &layout.at("downloads"), &mut arrived)
                .await
                .map_err(|error| match error {
                    FetchError::Io(error) => (Failure::Start, format!("download: {error}")),
                    other => (Failure::Download, other.to_string()),
                })?;
            files.push(Some(file));
        }
        Ok(files)
    }

    /// Postgres (made on the first start), the migrations, then the three server processes.
    async fn run(&self, plan: &Plan, layout: &Layout, launch: &Arc<Launch>) -> Result<(), String> {
        let pgdata = layout.at("pgdata");
        if !pgdata.join("PG_VERSION").exists() {
            self.initdb(plan, layout, launch).await?;
        }
        if cfg!(windows) {
            // Postgres refuses to run with an administrator's rights, which pg_ctl gives up for
            // it. It then runs on its own (in pg_ctl's job, ended with the app): pg_ctl stops it,
            // after the others.
            self.running
                .lock()
                .await
                .supervisor
                .at_stop(plan.pg_ctl_stop(&pgdata), launch.clone());
            stack_proc::run_once(
                &plan.pg_ctl_start(&pgdata, &layout.at("logs")),
                launch,
                Duration::from_secs(90),
            )
            .await?;
        } else {
            self.keep(plan.postgres(&pgdata), launch).await?;
        }
        let checks = self.checks.clone();
        let (bin, port) = (plan.pg_bin.clone(), plan.ports.postgres);
        if !wait_until(Duration::from_secs(60), move || checks.postgres(&bin, port)).await {
            return Err("Postgres was not ready after 60 s".into());
        }
        let created = layout.at("db-created");
        if !created.exists() {
            match stack_proc::run_once(&plan.createdb(), launch, Duration::from_secs(60)).await {
                Ok(()) => {}
                // A first start cut off after this step: the database is there.
                Err(_) if log_says(layout, "createdb", "already exists") => {}
                Err(why) => return Err(why),
            }
            fs::write(&created, "").map_err(|error| error.to_string())?;
        }
        stack_proc::run_once(&plan.migrate(), launch, Duration::from_secs(600)).await?;
        for spec in [plan.api(), plan.worker(), plan.web()] {
            self.keep(spec, launch).await?;
        }
        let checks = self.checks.clone();
        let ports = plan.ports;
        if !wait_until(Duration::from_secs(120), move || checks.server(ports)).await {
            return Err("the API and the web server were not ready after 120 s".into());
        }
        Ok(())
    }

    async fn initdb(
        &self,
        plan: &Plan,
        layout: &Layout,
        launch: &Arc<Launch>,
    ) -> Result<(), String> {
        let fresh = layout.at("pgdata.init");
        let password = layout.at("run/pwfile");
        let _ = fs::remove_dir_all(&fresh);
        stack_setup::write_private(&password, plan.owner_password.as_bytes())
            .map_err(|error| format!("pwfile: {error}"))?;
        let result = stack_proc::run_once(
            &plan.initdb(&fresh, &password),
            launch,
            Duration::from_secs(300),
        )
        .await;
        let _ = fs::remove_file(&password);
        result?;
        fs::rename(&fresh, layout.at("pgdata")).map_err(|error| error.to_string())
    }

    async fn keep(&self, spec: Spec, launch: &Arc<Launch>) -> Result<(), String> {
        let name = spec.name;
        self.running
            .lock()
            .await
            .supervisor
            .keep(spec, launch.clone())
            .await
            .map_err(|error| format!("{name} did not start: {error}"))
    }
}

/// The folder's lock. Right after a stop, what a process started can hold it a moment longer
/// (it inherits the lock and is just ending), so a taken lock is asked again for 3 seconds
/// before another app counts as holding it.
async fn take_lock(file: &Path) -> Result<fs::File, Failure> {
    for _ in 0..30 {
        if let Some(lock) = stack_setup::lock(file).map_err(|_| Failure::Start)? {
            return Ok(lock);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(Failure::AlreadyRunning)
}

/// The manifest's entry for this computer.
async fn fetch_release(options: &Options) -> Result<Release, (Failure, String)> {
    let platform = stack_manifest::platform()
        .ok_or((Failure::Unsupported, "no bundle for this system".into()))?;
    let text = read_manifest(&options.manifest)
        .await
        .map_err(|why| (Failure::Download, format!("manifest: {why}")))?;
    stack_manifest::parse(&text, platform)
        .map_err(|why| (Failure::Unsupported, format!("manifest: {why}")))
}

/// The version recorded as installed, if its folder is there.
fn installed(layout: &Layout) -> Option<String> {
    let version = fs::read_to_string(layout.at("current")).ok()?;
    let version = version.trim();
    layout.version(version).is_dir().then(|| version.to_owned())
}

async fn read_manifest(address: &str) -> Result<String, String> {
    if let Some(path) = stack_fetch::local_path(address).or_else(|| {
        Path::new(address)
            .is_absolute()
            .then(|| PathBuf::from(address))
    }) {
        return fs::read_to_string(path).map_err(|error| error.to_string());
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(address)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    response.text().await.map_err(|error| error.to_string())
}

fn log_says(layout: &Layout, name: &str, words: &str) -> bool {
    fs::read_to_string(layout.at("logs").join(format!("{name}.log")))
        .is_ok_and(|log| log.contains(words))
}

/// Asks `check` until it says yes, for at most `limit`.
async fn wait_until(limit: Duration, check: impl Fn() -> bool + Send + Sync + 'static) -> bool {
    let check = Arc::new(check);
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        let ask = check.clone();
        if tokio::task::spawn_blocking(move || ask())
            .await
            .unwrap_or(false)
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// The relay host agent's commands (`dozo/relay/agent/README.md`) for the running server.
#[derive(Clone)]
pub struct Agent {
    base: Spec,
    state: PathBuf,
    relay: String,
    /// The server's web address: `run` forwards there, `approve` and `revoke` reach it there.
    origin: String,
    launch: Arc<Launch>,
}

/// A pairing offer: what the QR code holds and when it stops working.
#[derive(Clone, Debug, PartialEq)]
pub struct Offer {
    pub channel: String,
    pub qr: String,
    pub expires_at: Value,
}

/// A paired phone, as `list` names it.
#[derive(Clone, Debug, PartialEq)]
pub struct Phone {
    pub channel: String,
    pub paired_at: Value,
}

impl Agent {
    /// The command line: options first, a channel last after `--` (`channel_last`).
    fn spec(&self, command: &str, args: &[&str]) -> Spec {
        let mut spec = self.base.clone();
        spec.args.push(command.into());
        spec.args.push("--state".into());
        spec.args.push(self.state.clone().into());
        spec.args.extend(args.iter().map(Into::into));
        spec
    }

    async fn ask(&self, command: &str, args: &[&str]) -> Result<Value, String> {
        let mut spec = self.spec(command, args);
        spec.name = "relay-command";
        let text = stack_proc::output(&spec, &self.launch, Duration::from_secs(30)).await;
        let text = text.inspect_err(|why| self.launch.note(&format!("relay {command}: {why}")))?;
        text.lines()
            .rev()
            .find_map(|line| serde_json::from_str(line).ok())
            .ok_or_else(|| format!("relay {command} printed no JSON"))
    }

    /// A new pairing offer; it works once, for ten minutes, while `run` is connected.
    pub async fn offer(&self) -> Result<Offer, String> {
        let answer = self.ask("pair", &["--relay", &self.relay]).await?;
        let text = |key: &str| answer.get(key).and_then(Value::as_str).map(str::to_owned);
        Ok(Offer {
            channel: text("channel").ok_or("no channel")?,
            qr: text("qr").ok_or("no qr")?,
            expires_at: answer.get("expiresAt").cloned().unwrap_or(Value::Null),
        })
    }

    /// The paired phones; offers still open are left out.
    pub async fn phones(&self) -> Result<Vec<Phone>, String> {
        let answer = self.ask("list", &[]).await?;
        let channels = answer.get("channels").and_then(Value::as_array);
        Ok(channels
            .into_iter()
            .flatten()
            .filter(|entry| entry.get("state").and_then(Value::as_str) == Some("paired"))
            .filter_map(|entry| {
                Some(Phone {
                    channel: entry.get("channel")?.as_str()?.to_owned(),
                    paired_at: entry.get("pairedAt").cloned().unwrap_or(Value::Null),
                })
            })
            .collect())
    }

    /// Ends a phone's pairing: on the relay when it can be reached, its session on the server,
    /// and its keys here always. A phone not allowed yet is refused the same way.
    pub async fn remove(&self, channel: &str) -> Result<(), String> {
        self.ask("revoke", &["--origin", &self.origin, "--", channel])
            .await
            .map(drop)
    }

    /// The person allowed the phone that just paired: it gets its sign-in.
    pub async fn approve(&self, channel: &str) -> Result<(), String> {
        // After `--`: a channel id is base64url, so one in 64 starts with `-`, which would read
        // as an option.
        self.ask("approve", &["--", channel]).await.map(drop)
    }
}

/// A `run` line about a phone's pairing, with its channel.
fn phone_event_of(line: &[u8]) -> Option<Value> {
    let event: Value = serde_json::from_slice(line).ok()?;
    let kind = event.get("event")?.as_str()?;
    event.get("channel")?.as_str()?;
    ["paired", "approval", "approved", "expired"]
        .contains(&kind)
        .then_some(event)
}

/// Takes `event` as the last word about a phone, unless it would hide a question the person has
/// to answer: `paired` comes once the pairing is stored and on the relay, and the phone may ask
/// for its sign-in (`approval`) before that. True when it was taken.
fn keep_phone_event(last: &mut Option<Value>, event: Value) -> bool {
    let asking = last.as_ref().is_some_and(|last| {
        last["event"] == "approval" && event_channel(last) == event_channel(&event)
    });
    if asking && event["event"] == "paired" {
        return false;
    }
    *last = Some(event);
    true
}

/// The channel a phone event is about.
pub fn event_channel(event: &Value) -> Option<&str> {
    event.get("channel")?.as_str()
}

/// Every process of one start: programs, folders and variables (the README's table).
struct Plan {
    root: PathBuf,
    node: PathBuf,
    pg_bin: PathBuf,
    server: PathBuf,
    entrypoints: Value,
    version: String,
    ports: Ports,
    web: String,
    path: String,
    owner_password: String,
    owner_url: String,
    app_url: String,
    secrets: Vec<(String, String)>,
    hosted_login_issuer: Option<String>,
    /// The person's home and login `PATH` (`stack_setup::user_environment`).
    user: Vec<(&'static str, String)>,
}

impl Plan {
    fn new(
        layout: &Layout,
        version: &str,
        ports: Ports,
        secrets: &Secrets,
        options: &Options,
    ) -> Result<Plan, String> {
        let installed = layout.version(version);
        let node_dir = if cfg!(windows) {
            installed.join("node")
        } else {
            installed.join("node/bin")
        };
        let server = installed.join("server/rakazo-server");
        let manifest: Value = fs::read_to_string(server.join("manifest.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .ok_or("the bundle's manifest.json is missing or not JSON")?;
        let path = std::env::join_paths(
            std::iter::once(node_dir.clone()).chain(
                std::env::var_os("PATH")
                    .iter()
                    .flat_map(std::env::split_paths),
            ),
        )
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .into_owned();
        let url = |user: &str, password: &str| {
            format!(
                "postgres://{user}:{password}@127.0.0.1:{}/rakazo",
                ports.postgres
            )
        };
        Ok(Plan {
            root: layout.0.clone(),
            node: node_dir.join(exe("node")),
            pg_bin: installed.join("postgres/bin"),
            entrypoints: manifest.get("entrypoints").cloned().unwrap_or(Value::Null),
            version: manifest
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or(version)
                .to_owned(),
            server,
            ports,
            web: format!("http://127.0.0.1:{}", ports.web),
            path,
            owner_password: secrets.get("PG_OWNER_PASSWORD").to_owned(),
            // The secrets are hex: nothing to escape in a URL.
            owner_url: url("rakazo", secrets.get("PG_OWNER_PASSWORD")),
            app_url: url("rakazo_app", secrets.get("PG_APP_PASSWORD")),
            secrets: stack_setup::SECRET_KEYS
                .iter()
                .map(|key| ((*key).to_owned(), secrets.get(key).to_owned()))
                .collect(),
            hosted_login_issuer: options.hosted_login_issuer.clone(),
            user: Vec::new(),
        })
    }

    fn secret(&self, key: &str) -> String {
        self.secrets
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
            .unwrap_or_default()
    }

    /// `PATH` with Node first and `HOME` in the server's folder, plus what Windows cannot start
    /// a process without.
    fn base(&self) -> Vec<(String, String)> {
        let mut env = vec![
            ("PATH".into(), self.path.clone()),
            ("HOME".into(), self.root.to_string_lossy().into_owned()),
        ];
        if cfg!(windows) {
            for key in [
                "SystemRoot",
                "windir",
                "ComSpec",
                "PATHEXT",
                "TEMP",
                "TMP",
                "USERPROFILE",
                "LOCALAPPDATA",
                "APPDATA",
            ] {
                if let Ok(value) = std::env::var(key) {
                    env.push((key.into(), value));
                }
            }
        }
        env
    }

    fn pg_spec(&self, name: &'static str, args: Vec<String>, env: Vec<(String, String)>) -> Spec {
        let mut all = self.base();
        all.extend(env);
        Spec {
            name,
            program: self.pg_bin.join(exe(name)),
            args: args.into_iter().map(Into::into).collect(),
            cwd: self.root.clone(),
            env: all,
            stop: Stop::Interrupt,
            grace: Duration::from_secs(20),
            on_line: None,
        }
    }

    fn initdb(&self, into: &Path, password: &Path) -> Spec {
        let args = [
            "-D",
            &into.to_string_lossy(),
            "-U",
            "rakazo",
            &format!("--pwfile={}", password.display()),
            "-A",
            "scram-sha-256",
            "-E",
            "UTF8",
            "--locale=C",
        ];
        self.pg_spec("initdb", args.map(str::to_owned).to_vec(), vec![])
    }

    /// TCP on loopback only; no Unix socket, whose path the user's folder could make too long.
    fn postgres(&self, pgdata: &Path) -> Spec {
        let args = [
            "-D",
            &pgdata.to_string_lossy(),
            "-p",
            &self.ports.postgres.to_string(),
            "-c",
            "listen_addresses=127.0.0.1",
            "-c",
            "unix_socket_directories=",
            // initdb wrote this computer's zone into the data folder; the server's SQL expects UTC
            // (`dozo/server-bundle/README.md`, "Start contract").
            "-c",
            "timezone=UTC",
        ];
        self.pg_spec("postgres", args.map(str::to_owned).to_vec(), vec![])
    }

    /// Postgres on Windows (`run`): started by pg_ctl, which waits until it answers. Its log is
    /// the file pg_ctl names.
    fn pg_ctl_start(&self, pgdata: &Path, logs: &Path) -> Spec {
        // UTC as `postgres` above: initdb wrote this computer's zone into the data folder.
        let options = format!(
            "-p {} -c listen_addresses=127.0.0.1 -c timezone=UTC",
            self.ports.postgres
        );
        let log = logs.join("postgres.log");
        let args = [
            "start",
            "-D",
            &pgdata.to_string_lossy(),
            "-l",
            &log.to_string_lossy(),
            "-o",
            &options,
            "-w",
            "-t",
            "60",
            "-s",
        ];
        self.pg_spec("pg_ctl", args.map(str::to_owned).to_vec(), vec![])
    }

    fn pg_ctl_stop(&self, pgdata: &Path) -> Spec {
        let args = [
            "stop",
            "-D",
            &pgdata.to_string_lossy(),
            "-m",
            "fast",
            "-w",
            "-t",
            "20",
            "-s",
        ];
        let mut spec = self.pg_spec("pg_ctl", args.map(str::to_owned).to_vec(), vec![]);
        spec.grace = Duration::from_secs(30);
        spec
    }

    fn createdb(&self) -> Spec {
        let port = self.ports.postgres.to_string();
        let args = ["-h", "127.0.0.1", "-p", &port, "-U", "rakazo", "rakazo"];
        let env = vec![("PGPASSWORD".into(), self.owner_password.clone())];
        self.pg_spec("createdb", args.map(str::to_owned).to_vec(), env)
    }

    fn node_spec(&self, name: &'static str, env: Vec<(&str, String)>) -> Spec {
        let entry = self
            .entrypoints
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut all = self.base();
        all.push(("NODE_ENV".into(), "production".into()));
        all.push(("RAKAZO_ENV_FILE".into(), "none".into()));
        all.extend(env.into_iter().map(|(key, value)| (key.to_owned(), value)));
        Spec {
            name,
            program: self.node.clone(),
            args: vec![entry.into()],
            cwd: self.server.clone(),
            env: all,
            stop: Stop::Terminate,
            grace: Duration::from_secs(10),
            on_line: None,
        }
    }

    /// The relay agent's commands, when the bundle has it: they run with Node from the
    /// server's folder and keep their keys in `relay/`.
    fn agent(&self, layout: &Layout, options: &Options, launch: &Arc<Launch>) -> Option<Agent> {
        let entry = self.entrypoints.get("relay").and_then(Value::as_str)?;
        // By its real path: the agent runs only when Node's path for it is the one it was
        // loaded from, which a folder reached through a link (macOS's /var) would break. Not on
        // Windows, where the real path starts with `\\?\`, which Node does not give back.
        // The key the agent shows the server when it asks a phone's sign-in.
        let key = vec![("DOZO_RELAY_AGENT_KEY", self.secret("RELAY_AGENT_KEY"))];
        let mut base = self.node_spec("relay", key);
        if cfg!(unix)
            && let Ok(real) = fs::canonicalize(self.server.join(entry))
        {
            base.args = vec![real.into()];
        }
        Some(Agent {
            base,
            state: layout.at("relay"),
            relay: options.relay.clone(),
            origin: self.web.clone(),
            // Its one-shot commands (pair, list, revoke) are not the server: they do not hold the
            // folder's lock, so one still running never keeps the next start out.
            launch: Arc::new(launch.without_lock()),
        })
    }

    fn migrate(&self) -> Spec {
        self.node_spec(
            "migrate",
            vec![
                ("DATABASE_URL", self.app_url.clone()),
                ("DATABASE_MIGRATION_URL", self.owner_url.clone()),
                ("RAKAZO_DB_PACKAGE_DIR", "packages/db".into()),
            ],
        )
    }

    /// What the API and the worker both get.
    fn app(&self) -> Vec<(&'static str, String)> {
        let mut env = vec![
            ("DATABASE_URL", self.app_url.clone()),
            (
                "DATA_DIR",
                self.root.join("data").to_string_lossy().into_owned(),
            ),
            ("SANDBOX_PROVIDER", "none".into()),
            ("CONTENT_ENCRYPTION", "off".into()),
            ("WAKEUP_DRIVER", "graphile".into()),
            ("AGENT_RUNTIME", "pi".into()),
            ("MCP_ALLOW_PRIVATE_ENDPOINT", "true".into()),
            ("BETTER_AUTH_URL", self.web.clone()),
            ("WEB_ORIGIN", self.web.clone()),
            ("API_URL", self.web.clone()),
            ("RAKAZO_DESKTOP_STACK_TOKEN", self.secret("STACK_TOKEN")),
            ("SCREEN_PROXY_SECRET", self.secret("SCREEN_PROXY_SECRET")),
            ("BETTER_AUTH_SECRET", self.secret("BETTER_AUTH_SECRET")),
            ("ENCRYPTION_KEY", self.secret("ENCRYPTION_KEY")),
        ];
        if let Some(issuer) = &self.hosted_login_issuer {
            env.push(("HOSTED_LOGIN_ISSUER", issuer.clone()));
        }
        env.extend(self.user.iter().cloned());
        env
    }

    fn api(&self) -> Spec {
        let mut env = self.app();
        env.extend([
            ("API_HOST", "127.0.0.1".into()),
            ("API_PORT", self.ports.api.to_string()),
            ("AUTH_PASSWORD_ENABLED", "true".into()),
            ("AUTH_BREACHED_PASSWORD_CHECK_ENABLED", "false".into()),
            // Phones sign in through the relay agent, which shows this key (agent README).
            ("DOZO_RELAY_AGENT_KEY", self.secret("RELAY_AGENT_KEY")),
        ]);
        if let Some(email) = FEEDBACK_EMAIL.filter(|email| !email.trim().is_empty()) {
            env.push(("DOZO_FEEDBACK_EMAIL", email.to_owned()));
        }
        // The API lets requests finish for up to 20 s after TERM (`apps/api/src/index.ts`).
        Spec {
            grace: Duration::from_secs(25),
            ..self.node_spec("api", env)
        }
    }

    fn worker(&self) -> Spec {
        self.node_spec("worker", self.app())
    }

    fn web(&self) -> Spec {
        self.node_spec(
            "web",
            vec![
                (
                    "API_PROXY_TARGET",
                    format!("http://127.0.0.1:{}", self.ports.api),
                ),
                ("SCREEN_PROXY_SECRET", self.secret("SCREEN_PROXY_SECRET")),
                ("WEB_HOST", "127.0.0.1".into()),
                ("WEB_PORT", self.ports.web.to_string()),
                ("RAKAZO_DESKTOP_STACK_TOKEN", self.secret("STACK_TOKEN")),
                ("RAKAZO_IMAGE_TAG", self.version.clone()),
            ],
        )
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::stack_fetch::tests::scratch;
    use std::os::unix::fs::PermissionsExt;

    /// Ready as soon as the stand-in processes said they are up.
    struct Said(PathBuf);

    impl Checks for Said {
        fn postgres(&self, _: &Path, _: u16) -> bool {
            lines_of(&self.0).iter().any(|line| line == "postgres")
        }
        fn server(&self, _: Ports) -> bool {
            let said = lines_of(&self.0);
            ["api.js", "worker.js", "web.js"]
                .iter()
                .all(|entry| said.iter().any(|line| line == entry))
        }
    }

    fn lines_of(file: &Path) -> Vec<String> {
        fs::read_to_string(file)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn script(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A stand-in relay agent: what each command prints.
    const RELAY: &str = r#"case "$2" in
      pair) echo '{"event":"offer","channel":"c1","relay":"r","expiresAt":"soon","qr":"dozo://pair#x"}'; exit 0;;
      list) echo '{"channels":[{"channel":"c2","state":"paired","appKey":"k","pairedAt":"then"},{"channel":"c3","state":"pairing","expiresAt":"soon"}]}'; exit 0;;
      revoke) echo '{"event":"error","reason":"no such channel"}'; exit 2;;
      approve) for a; do last=$a; done; echo "{\"event\":\"approved\",\"channel\":\"$last\"}"; exit 0;;
      run) echo "key=$DOZO_RELAY_AGENT_KEY" >> "$0.env"; echo '{"event":"connected","channel":"c2"}'; sleep 0.3
        echo '{"event":"paired","channel":"c9"}'
        echo '{"event":"approval","channel":"c9","platform":"android","code":"123456"}';;
    esac
    trap 'exit 0' TERM INT; while :; do sleep 0.05; done"#;

    const LOOP: &str = "trap 'exit 0' TERM INT; while :; do sleep 0.05; done";

    /// An installed version whose programs are shell scripts that write what they are to `said`.
    fn installed_fakes(root: &Path, said: &Path, migrate_exit: u8) {
        let version = root.join("versions/1");
        let s = said.display();
        script(
            &version.join("node/bin/node"),
            &format!(
                "case \"$1\" in relay.js) echo \"$*\" >> {s}.relay; {RELAY};; esac
                case \"$1\" in api.js) echo \"$HOME|$HOST_USER_HOME|$HOST_USER_PATH\" > {s}.user;; esac
                echo \"$1\" >> {s}; case \"$1\" in migrate.js) exit {migrate_exit};; esac; {LOOP}"
            ),
        );
        let pg = version.join("postgres/bin");
        script(
            &pg.join("postgres"),
            &format!("echo \"$*\" > {s}.pg; echo postgres >> {s}; {LOOP}"),
        );
        script(
            &pg.join("initdb"),
            &format!("echo initdb >> {s}; mkdir -p \"$2\"; echo 16 > \"$2/PG_VERSION\""),
        );
        script(&pg.join("createdb"), &format!("echo createdb >> {s}"));
        let server = version.join("server/rakazo-server");
        fs::create_dir_all(&server).unwrap();
        fs::write(
            server.join("manifest.json"),
            r#"{"version":"1","entrypoints":{"migrate":"migrate.js","api":"api.js","worker":"worker.js","web":"web.js","relay":"relay.js"}}"#,
        )
        .unwrap();
        fs::write(root.join("current"), "1").unwrap();
    }

    fn options() -> Options {
        Options {
            manifest: "file:///nowhere/manifest.json".into(),
            hosted_login_issuer: None,
            relay: "http://127.0.0.1:9".into(),
            // The stand-ins are installed as version 1, the one expected: no manifest is read.
            expected: Some("1".into()),
        }
    }

    async fn settled(local: &Local) -> Status {
        let mut status = local.status();
        let wait = status.wait_for(|status| matches!(status, Status::Ready(_) | Status::Failed(_)));
        tokio::time::timeout(Duration::from_secs(30), wait)
            .await
            .unwrap()
            .unwrap()
            .clone()
    }

    #[tokio::test]
    async fn starts_in_order_and_makes_the_database_once() {
        let root = scratch("order-stack");
        let said = root.join("said");
        installed_fakes(&root, &said, 0);
        let local = Local::new(Arc::new(Said(said.clone())));
        local.start(Layout(root.clone()), options()).await;
        let Status::Ready(url) = settled(&local).await else {
            panic!("not ready: {:?}", local.status().borrow().clone());
        };
        let ports = fs::read_to_string(root.join("ports")).unwrap();
        assert!(ports.contains(&format!("web={}", url[17..].trim_end_matches('/'))));
        let first = lines_of(&said);
        // The agent starts last; its first line can come after the server is ready.
        tokio::time::timeout(Duration::from_secs(5), async {
            while lines_of(&root.join("said.relay")).is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            lines_of(&root.join("said.relay")),
            [format!(
                "relay.js run --state {} --origin http://127.0.0.1:{}",
                root.join("relay").display(),
                url[17..].trim_end_matches('/')
            )]
        );
        assert_eq!(first[..4], ["initdb", "postgres", "createdb", "migrate.js"]);
        // Postgres runs in UTC whatever this computer's zone, on every start.
        let pg = lines_of(&root.join("said.pg")).join(" ");
        assert!(pg.contains("-c timezone=UTC"), "{pg}");
        let mut rest = first[4..].to_vec();
        rest.sort();
        assert_eq!(rest, ["api.js", "web.js", "worker.js"]);
        // The API runs in the server's own HOME and is told the person's.
        let user = lines_of(&root.join("said.user")).join("");
        let [home, user_home, user_path] = user.split('|').collect::<Vec<_>>()[..] else {
            panic!("{user}");
        };
        assert_eq!(home, root.to_string_lossy());
        assert_eq!(user_home, std::env::var("HOME").unwrap());
        assert!(!user_path.is_empty());
        // The folder is held while it runs.
        assert!(
            stack_setup::lock(&root.join("stack.lock"))
                .unwrap()
                .is_none()
        );
        assert!(local.stop().await);
        assert_eq!(*local.status().borrow(), Status::Off);
        assert!(take_lock(&root.join("stack.lock")).await.is_ok());

        // The second start keeps the database: no initdb, no createdb.
        fs::remove_file(&said).unwrap();
        local.start(Layout(root.clone()), options()).await;
        assert!(matches!(settled(&local).await, Status::Ready(_)));
        assert_eq!(lines_of(&said)[..2], ["postgres", "migrate.js"]);
        assert!(local.stop().await);
        let mode = fs::metadata(root.join("secrets"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[tokio::test]
    async fn the_relay_agent_runs_with_the_server_and_answers_for_phones() {
        let root = scratch("relay-agent");
        let said = root.join("said");
        installed_fakes(&root, &said, 0);
        let local = Local::new(Arc::new(Said(said.clone())));
        let mut events = local.phone_events();
        local.start(Layout(root.clone()), options()).await;
        assert!(matches!(settled(&local).await, Status::Ready(_)));
        let agent = local.agent().await.expect("the bundle has an agent");
        let offer = agent.offer().await.unwrap();
        assert_eq!(offer.channel, "c1");
        assert_eq!(offer.qr, "dozo://pair#x");
        assert_eq!(
            agent.phones().await.unwrap(),
            [Phone {
                channel: "c2".into(),
                paired_at: json!("then")
            }]
        );
        assert!(
            agent
                .remove("c2")
                .await
                .unwrap_err()
                .contains("no such channel")
        );
        let heard = events.wait_for(|event| {
            event
                .as_ref()
                .is_some_and(|event| event["event"] == "approval")
        });
        tokio::time::timeout(Duration::from_secs(5), heard)
            .await
            .unwrap()
            .unwrap();
        let commands = lines_of(&root.join("said.relay"));
        let state = root.join("relay").display().to_string();
        assert!(commands.contains(&format!(
            "relay.js pair --state {state} --relay http://127.0.0.1:9"
        )));
        let web = local_web(&root);
        assert!(commands.contains(&format!(
            "relay.js revoke --state {state} --origin {web} -- c2"
        )));
        let approval = events.borrow().clone().unwrap();
        assert_eq!(approval["code"], "123456");
        assert_eq!(approval["platform"], "android");
        agent.approve("c9").await.unwrap();
        let commands = lines_of(&root.join("said.relay"));
        assert!(commands.contains(&format!("relay.js approve --state {state} -- c9")));
        // A channel id may start with "-" (base64url): it still reaches the agent as a channel.
        agent.approve("-dash").await.unwrap();
        let commands = lines_of(&root.join("said.relay"));
        assert!(commands.contains(&format!("relay.js approve --state {state} -- -dash")));
        // The agent and the API get the same key, made with the other secrets.
        let key = stack_setup::secrets(&root.join("secrets")).unwrap();
        let key = key.get("RELAY_AGENT_KEY").to_owned();
        assert_eq!(key.len(), 64);
        let node = root.join("versions/1/node/bin/node.env");
        assert_eq!(lines_of(&node), [format!("key={key}")]);
        assert!(local.stop().await);
        assert!(local.agent().await.is_none());
    }

    #[test]
    fn a_late_paired_does_not_hide_the_question_for_the_same_phone() {
        let event = |line: &[u8]| phone_event_of(line).unwrap();
        let mut last = None;
        assert!(keep_phone_event(
            &mut last,
            event(br#"{"event":"approval","channel":"c1","code":"1"}"#)
        ));
        assert!(!keep_phone_event(
            &mut last,
            event(br#"{"event":"paired","channel":"c1","appKey":"k"}"#)
        ));
        assert_eq!(last.as_ref().unwrap()["event"], "approval");
        assert!(keep_phone_event(
            &mut last,
            event(br#"{"event":"paired","channel":"c2","appKey":"k"}"#)
        ));
        assert!(keep_phone_event(
            &mut last,
            event(br#"{"event":"approved","channel":"c2"}"#)
        ));
    }

    #[test]
    fn only_pairing_events_with_a_channel_are_kept() {
        let event = phone_event_of(br#"{"event":"paired","channel":"c1","appKey":"k"}"#).unwrap();
        assert_eq!(event_channel(&event), Some("c1"));
        assert!(phone_event_of(br#"{"event":"approval","channel":"c1","code":"1"}"#).is_some());
        assert!(phone_event_of(br#"{"event":"peer","channel":"c1"}"#).is_none());
        assert!(phone_event_of(br#"{"event":"paired"}"#).is_none());
        assert!(phone_event_of(b"not json").is_none());
    }

    fn local_web(root: &Path) -> String {
        let ports = stack_setup::saved_ports(&root.join("ports")).unwrap();
        format!("http://127.0.0.1:{}", ports.web)
    }

    /// On macOS the app's config and local data folders are one folder: the settings file and
    /// the server's folder sit side by side there and must not share a name.
    #[tokio::test]
    async fn it_starts_where_the_settings_file_lives_too() {
        let both = scratch("one-folder");
        let settings = crate::settings::Settings {
            this_computer: true,
            ..Default::default()
        };
        crate::settings::save(&both.join(crate::settings::FILE), &settings).unwrap();
        let root = folder_in(&both);
        let said = root.join("said");
        installed_fakes(&root, &said, 0);
        let local = Local::new(Arc::new(Said(said)));
        local.start(Layout(root), options()).await;
        assert!(matches!(settled(&local).await, Status::Ready(_)));
        assert!(local.stop().await);
        let saved = fs::read_to_string(both.join(crate::settings::FILE)).unwrap();
        assert_eq!(crate::settings::parse(&saved), settings);
    }

    #[test]
    fn a_folder_under_the_old_name_moves_once_and_nothing_else_does() {
        // An old server folder moves, with what is in it.
        let data = scratch("old-folder");
        fs::create_dir_all(data.join("server/pgdata")).unwrap();
        fs::write(data.join("server/secrets"), "kept").unwrap();
        let folder = folder_in(&data);
        assert_eq!(folder, data.join("local-server"));
        assert_eq!(fs::read_to_string(folder.join("secrets")).unwrap(), "kept");
        assert!(!data.join("server").exists());
        // With the new one there, the old one is left alone.
        let both = scratch("both-folders");
        fs::create_dir_all(both.join("server")).unwrap();
        fs::create_dir_all(both.join("local-server")).unwrap();
        fs::write(both.join("local-server/secrets"), "new").unwrap();
        folder_in(&both);
        assert!(both.join("server").is_dir());
        assert_eq!(
            fs::read_to_string(both.join("local-server/secrets")).unwrap(),
            "new"
        );
        // The settings file of that name stays where it is.
        let mac = scratch("settings-file");
        fs::write(mac.join("server"), "https://dozo.example.com/\n").unwrap();
        assert_eq!(folder_in(&mac), mac.join("local-server"));
        assert!(mac.join("server").is_file());
    }

    /// Version 2 of the stand-ins as a manifest with its three archives: its Postgres writes `v2`
    /// into the data (what a migration does), its migration exits with `migrate_exit`.
    fn release_2(dir: &Path, said: &Path, migrate_exit: u8) -> String {
        use sha2::{Digest, Sha256};
        let stage = dir.join("stage");
        let s = said.display();
        script(
            &stage.join("node/bin/node"),
            &format!(
                "case \"$1\" in relay.js) {LOOP};; esac
                echo \"v2 $1\" >> {s}; case \"$1\" in migrate.js) exit {migrate_exit};; esac; {LOOP}"
            ),
        );
        let pg = stage.join("postgres/bin");
        script(
            &pg.join("postgres"),
            &format!(
                "[ \"$1\" = --version ] && exit 0; echo v2 > \"$2/marker\"; echo postgres >> {s}; {LOOP}"
            ),
        );
        script(&pg.join("initdb"), "exit 1");
        script(&pg.join("createdb"), "exit 0");
        let server = stage.join("server/rakazo-server");
        fs::create_dir_all(&server).unwrap();
        fs::write(
            server.join("manifest.json"),
            r#"{"version":"2","entrypoints":{"migrate":"migrate.js","api":"api.js","worker":"worker.js","web":"web.js"}}"#,
        )
        .unwrap();
        let mut parts = serde_json::Map::new();
        for (name, top) in [
            ("node", "node"),
            ("postgres", "postgres"),
            ("server", "server"),
        ] {
            let file = dir.join(format!("{name}.tar.gz"));
            let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
                fs::File::create(&file).unwrap(),
                flate2::Compression::fast(),
            ));
            // node and postgres hold one top folder, the server its rakazo-server/.
            if name == "server" {
                builder.append_dir_all(".", stage.join(top)).unwrap();
            } else {
                builder.append_dir_all(top, stage.join(top)).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap();
            let bytes = fs::read(&file).unwrap();
            let sha: String = Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            parts.insert(
                name.into(),
                json!({ "url": format!("file://{}", file.display()), "sha256": sha, "size": bytes.len() }),
            );
        }
        let manifest = json!({ "schema": 1, "version": "2", "platforms": {
            stack_manifest::platform().unwrap(): parts } });
        let path = dir.join("manifest.json");
        fs::write(&path, manifest.to_string()).unwrap();
        format!("file://{}", path.display())
    }

    fn update_options(manifest: String) -> Options {
        Options {
            manifest,
            expected: Some("2".into()),
            ..options()
        }
    }

    #[tokio::test]
    async fn an_update_installs_the_new_version_beside_and_keeps_a_copy() {
        let root = scratch("update-to-2");
        let said = root.join("said");
        installed_fakes(&root, &said, 0);
        let local = Local::new(Arc::new(Said(said.clone())));
        local.start(Layout(root.clone()), options()).await;
        assert!(matches!(settled(&local).await, Status::Ready(_)));
        assert!(local.stop().await);
        fs::write(root.join("pgdata/marker"), "v1").unwrap();

        let manifest = release_2(&scratch("release-2"), &said, 0);
        let mut seen = local.status();
        local
            .start(Layout(root.clone()), update_options(manifest))
            .await;
        let (mut updating, mut saw_install_steps) = (false, false);
        while !matches!(
            *seen.borrow_and_update(),
            Status::Ready(_) | Status::Failed(_)
        ) {
            updating |= *seen.borrow() == Status::Updating;
            saw_install_steps |=
                matches!(*seen.borrow(), Status::Downloading(_) | Status::Preparing);
            tokio::time::timeout(Duration::from_secs(30), seen.changed())
                .await
                .unwrap()
                .unwrap();
        }
        assert!(updating, "the window never said it was updating");
        assert!(!saw_install_steps, "an update shows Updating only");
        assert!(
            matches!(*seen.borrow(), Status::Ready(_)),
            "{:?}",
            seen.borrow()
        );
        assert_eq!(fs::read_to_string(root.join("current")).unwrap(), "2");
        assert_eq!(
            fs::read_to_string(root.join("pgdata/marker")).unwrap(),
            "v2\n"
        );
        assert!(lines_of(&said).contains(&"v2 migrate.js".to_owned()));
        assert!(stack_update::journal(&root).is_none());
        let copies: Vec<_> = fs::read_dir(root.join("before-update")).unwrap().collect();
        assert_eq!(copies.len(), 1);
        assert!(
            root.join("versions/1").is_dir(),
            "the previous version stays for now"
        );
        assert!(local.stop().await);
        // Started again: the expected version is installed, nothing is read or copied.
        let missing = Options {
            manifest: "file:///nowhere".into(),
            expected: Some("2".into()),
            ..options()
        };
        local.start(Layout(root.clone()), missing).await;
        assert!(matches!(settled(&local).await, Status::Ready(_)));
        assert!(local.stop().await);
    }

    #[tokio::test]
    async fn an_update_that_does_not_start_puts_everything_back_once() {
        let root = scratch("update-fails");
        let said = root.join("said");
        installed_fakes(&root, &said, 0);
        let local = Local::new(Arc::new(Said(said.clone())));
        local.start(Layout(root.clone()), options()).await;
        assert!(matches!(settled(&local).await, Status::Ready(_)));
        assert!(local.stop().await);
        fs::write(root.join("pgdata/marker"), "v1").unwrap();

        let manifest = release_2(&scratch("release-2-broken"), &said, 1);
        local
            .start(Layout(root.clone()), update_options(manifest.clone()))
            .await;
        assert_eq!(
            settled(&local).await,
            Status::Failed(Failure::UpdateRolledBack)
        );
        assert_eq!(fs::read_to_string(root.join("current")).unwrap(), "1");
        assert_eq!(
            fs::read_to_string(root.join("pgdata/marker")).unwrap(),
            "v1"
        );
        assert!(stack_update::journal(&root).is_none());
        let events = fs::read_to_string(root.join("logs/manager.log")).unwrap();
        assert!(events.contains("updating from 1 to 2"), "{events}");

        // Try again: the version that failed is not tried on its own; the old one starts.
        fs::remove_file(&said).unwrap();
        local
            .start(Layout(root.clone()), update_options(manifest))
            .await;
        assert!(matches!(settled(&local).await, Status::Ready(_)));
        assert!(!lines_of(&said).iter().any(|line| line.starts_with("v2")));
        assert_eq!(fs::read_to_string(root.join("current")).unwrap(), "1");
        assert!(local.stop().await);
    }

    #[tokio::test]
    async fn a_start_that_fails_for_another_reason_undoes_no_update() {
        let root = scratch("update-unrelated");
        let said = root.join("said");
        installed_fakes(&root, &said, 0);
        let local = Local::new(Arc::new(Said(said.clone())));
        local.start(Layout(root.clone()), options()).await;
        assert!(matches!(settled(&local).await, Status::Ready(_)));
        assert!(local.stop().await);
        // The update was cut off after the switch, the new version had migrated...
        stack_update::begin(&root, "1", "2", 1).unwrap();
        fs::create_dir_all(root.join("versions/2")).unwrap();
        fs::write(root.join("current"), "2").unwrap();
        fs::write(root.join("pgdata/marker"), "v2").unwrap();
        // ...and now another app holds the folder: this start fails before looking at it.
        let held = stack_setup::lock(&root.join("stack.lock"))
            .unwrap()
            .unwrap();
        local
            .start(
                Layout(root.clone()),
                update_options("file:///nowhere".into()),
            )
            .await;
        assert_eq!(
            settled(&local).await,
            Status::Failed(Failure::AlreadyRunning)
        );
        assert!(
            stack_update::journal(&root).is_some(),
            "the journal is left for the next start"
        );
        assert_eq!(
            fs::read_to_string(root.join("pgdata/marker")).unwrap(),
            "v2"
        );
        assert_eq!(stack_update::skipped(&root), None);
        drop(held);
    }

    #[test]
    fn the_manifest_is_the_expected_version_s() {
        // Moving one without the other would update to a version the manifest does not name.
        if option_env!("DOZO_SERVER_MANIFEST").is_none() {
            assert!(
                MANIFEST.contains(&format!("/server-v{SERVER_VERSION}/")),
                "{MANIFEST}"
            );
        }
    }

    #[tokio::test]
    async fn an_older_manifest_never_takes_the_server_back() {
        let root = scratch("no-downgrade");
        let said = root.join("said");
        installed_fakes(&root, &said, 0);
        fs::rename(root.join("versions/1"), root.join("versions/3")).unwrap();
        fs::write(root.join("current"), "3").unwrap();
        let manifest = release_2(&scratch("release-2-older"), &said, 0);
        let local = Local::new(Arc::new(Said(said.clone())));
        local
            .start(Layout(root.clone()), update_options(manifest))
            .await;
        assert!(matches!(settled(&local).await, Status::Ready(_)));
        assert_eq!(fs::read_to_string(root.join("current")).unwrap(), "3");
        let events = fs::read_to_string(root.join("logs/manager.log")).unwrap();
        assert!(events.contains("older than 3: not going back"), "{events}");
        assert!(local.stop().await);
    }

    #[test]
    fn postgres_runs_in_utc_on_every_system() {
        let root = scratch("utc-everywhere");
        installed_fakes(&root, &root.join("said"), 0);
        let secrets = stack_setup::secrets(&root.join("secrets")).unwrap();
        let ports = Ports {
            postgres: 1,
            api: 2,
            web: 3,
        };
        let plan = Plan::new(&Layout(root.clone()), "1", ports, &secrets, &options()).unwrap();
        let args = |spec: Spec| {
            spec.args
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(" ")
        };
        // Linux and macOS start postgres itself; Windows starts it through pg_ctl.
        assert!(args(plan.postgres(&root.join("pgdata"))).contains("-c timezone=UTC"));
        assert!(
            args(plan.pg_ctl_start(&root.join("pgdata"), &root.join("logs")))
                .contains("-c timezone=UTC")
        );
    }

    #[tokio::test]
    async fn a_failed_migration_stops_postgres_and_says_so() {
        let root = scratch("migrate-fails");
        let said = root.join("said");
        installed_fakes(&root, &said, 1);
        let local = Local::new(Arc::new(Said(said.clone())));
        local.start(Layout(root.clone()), options()).await;
        assert_eq!(settled(&local).await, Status::Failed(Failure::Start));
        assert!(!lines_of(&said).iter().any(|line| line == "api.js"));
        // Postgres was stopped and the folder released.
        assert!(take_lock(&root.join("stack.lock")).await.is_ok());
        let events = fs::read_to_string(root.join("logs/manager.log")).unwrap();
        assert!(events.contains("postgres stopped"), "{events}");
        assert!(events.contains("migrate failed"), "{events}");
    }

    #[tokio::test]
    async fn a_second_holder_of_the_folder_is_refused() {
        let root = scratch("second");
        let said = root.join("said");
        installed_fakes(&root, &said, 0);
        let _held = stack_setup::lock(&root.join("stack.lock"))
            .unwrap()
            .unwrap();
        let local = Local::new(Arc::new(Said(said)));
        local.start(Layout(root.clone()), options()).await;
        assert_eq!(
            settled(&local).await,
            Status::Failed(Failure::AlreadyRunning)
        );
        assert_eq!(
            Status::Failed(Failure::AlreadyRunning).to_json()["message"],
            "Another Dozo is already running the server on this computer."
        );
    }

    #[tokio::test]
    async fn without_a_manifest_the_download_fails_with_one_sentence() {
        let root = scratch("no-manifest");
        let local = Local::new(Arc::new(RealChecks));
        local.start(Layout(root.clone()), options()).await;
        assert_eq!(settled(&local).await, Status::Failed(Failure::Download));
    }
}

#[cfg(test)]
#[path = "stack_e2e.rs"]
mod e2e;
