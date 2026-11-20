//! The server on this computer: installs it from the manifest on first use, then starts it in the
//! order and with the variables of `dozo/server-bundle/README.md` ("Start contract"): Postgres,
//! the migrations, then the API, the worker and the web server, ready once the API's `/health`
//! and the web page answer. It stops in reverse. What the window shows is `Status`.
//!
//! Its folder (`<app data>/server`):
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
use crate::stack_proc::{self, Backoff, Launch, Spec, Supervisor};
use crate::stack_setup::{self, PortError, Ports, Secrets};

/// The manifest of the server this app was built for. A build can name another
/// (`DOZO_SERVER_MANIFEST` at compile time), and so can the environment at run time, for tests
/// and development: an `https://`, `http://` or `file://` address, or a file's path.
const MANIFEST: &str = match option_env!("DOZO_SERVER_MANIFEST") {
    Some(manifest) => manifest,
    None => "https://github.com/SSilistre-dev/dozo/releases/download/server-v0.11.0/manifest.json",
};

/// Sign-in with the hosted account on this server (`packages/auth/src/dozo-hosted-login.ts`):
/// off unless the build or the environment names the hosted origin (`DOZO_HOSTED_LOGIN_ISSUER`).
const HOSTED_LOGIN_ISSUER: Option<&str> = option_env!("DOZO_HOSTED_LOGIN_ISSUER");

const LOG_MAX: u64 = 5 << 20;

#[derive(Clone, Debug)]
pub struct Options {
    pub manifest: String,
    pub hosted_login_issuer: Option<String>,
}

impl Options {
    pub fn from_build_and_environment() -> Options {
        let issuer = std::env::var("DOZO_HOSTED_LOGIN_ISSUER")
            .ok()
            .or(HOSTED_LOGIN_ISSUER.map(str::to_owned))
            .filter(|issuer| !issuer.trim().is_empty());
        Options {
            manifest: std::env::var("DOZO_SERVER_MANIFEST").unwrap_or_else(|_| MANIFEST.into()),
            hosted_login_issuer: issuer,
        }
    }
}

/// What the window shows while the server is set up, as one line.
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Off,
    Downloading(u8),
    Preparing,
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
        }
    }
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
        std::process::Command::new(bin.join(exe("pg_isready")))
            .args(["-q", "-t", "2", "-h", "127.0.0.1", "-p", &port.to_string()])
            .env_clear()
            .status()
            .is_ok_and(|status| status.success())
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
}

/// The server on this computer, as the app holds it. One start or stop at a time.
pub struct Local {
    status: watch::Sender<Status>,
    running: tokio::sync::Mutex<Running>,
    checks: Arc<dyn Checks>,
    backoff: Backoff,
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
        })
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
                    local.status.send_replace(Status::Failed(failure));
                }
            }
        }));
    }

    /// Stops the server and everything it started; true when all stopped when asked.
    pub async fn stop(&self) -> bool {
        let task = self.running.lock().await.task.take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        let clean = self.release().await;
        self.status.send_replace(Status::Off);
        clean
    }

    async fn release(&self) -> bool {
        let mut running = self.running.lock().await;
        let clean = running.supervisor.stop_all().await;
        running.lock = None;
        clean
    }

    async fn bring_up(&self, layout: &Layout, options: &Options) -> Result<String, Failure> {
        for folder in ["versions", "downloads", "logs", "data", "run"] {
            fs::create_dir_all(layout.at(folder)).map_err(|_| Failure::Start)?;
        }
        let lock = stack_setup::lock(&layout.at("stack.lock"))
            .map_err(|_| Failure::Start)?
            .ok_or(Failure::AlreadyRunning)?;
        let lock = Arc::new(lock);
        self.running.lock().await.lock = Some(lock.clone());
        let logs = layout.at("logs");
        let launch = Arc::new(Launch {
            events: stack_proc::events_log(&logs, LOG_MAX),
            logs,
            lock: Some(lock),
            backoff: self.backoff.clone(),
            log_max: LOG_MAX,
        });
        let failed = |failure: Failure, why: &str| {
            launch.note(&format!("start failed: {why}"));
            failure
        };
        if !stack_setup::has_libssl3() {
            return Err(failed(Failure::NoLibssl, "no libssl.so.3"));
        }
        let version = match installed(layout) {
            Some(version) => version,
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
        let plan = Plan::new(layout, &version, ports, &secrets, options)
            .map_err(|why| failed(Failure::Start, &why))?;
        self.run(&plan, layout, &launch)
            .await
            .map_err(|why| failed(Failure::Start, &why))?;
        launch.note(&format!("ready at {}", plan.web));
        Ok(format!("{}/", plan.web))
    }

    /// Downloads the three parts (one percentage over all of them), unpacks them into
    /// `versions/<version>` and records it as `current`.
    async fn install(
        &self,
        layout: &Layout,
        options: &Options,
    ) -> Result<String, (Failure, String)> {
        let platform = stack_manifest::platform()
            .ok_or((Failure::Unsupported, "no bundle for this system".into()))?;
        self.status.send_replace(Status::Downloading(0));
        let text = read_manifest(&options.manifest)
            .await
            .map_err(|why| (Failure::Download, format!("manifest: {why}")))?;
        let release = stack_manifest::parse(&text, platform)
            .map_err(|why| (Failure::Unsupported, format!("manifest: {why}")))?;
        let parts = [
            ("node", &release.node, true),
            ("postgres", &release.postgres, true),
            ("server", &release.server, false),
        ];
        for (name, part, _) in parts {
            if Format::of(&part.url).is_none() {
                return Err((Failure::Unsupported, format!("{name}: unknown archive")));
            }
        }
        let files = self.download_all(&release, layout).await?;
        self.status.send_replace(Status::Preparing);
        let target = layout.version(&release.version);
        let mut partial = target.as_os_str().to_owned();
        partial.push(".partial");
        let partial = PathBuf::from(partial);
        let unpacked = tokio::task::spawn_blocking({
            let partial = partial.clone();
            let jobs: Vec<(String, PathBuf, Format, bool)> = parts
                .iter()
                .zip(&files)
                .map(|((name, part, strip), file)| {
                    let format = Format::of(&part.url).expect("checked above");
                    ((*name).to_owned(), file.clone(), format, *strip)
                })
                .collect();
            move || -> std::io::Result<()> {
                fs::create_dir_all(&partial)?;
                for (name, file, format, strip) in jobs {
                    let into = partial.join(&name);
                    if !into.exists() {
                        stack_fetch::unpack(&file, format, &into, strip)?;
                    }
                    fs::remove_file(&file)?;
                }
                stack_setup::fit_postgres(&partial.join("postgres")).map_err(std::io::Error::other)
            }
        })
        .await
        .map_err(|error| (Failure::Start, error.to_string()))?;
        unpacked.map_err(|error| (Failure::Start, format!("unpack: {error}")))?;
        if target.exists() {
            fs::remove_dir_all(&target).map_err(|error| (Failure::Start, error.to_string()))?;
        }
        fs::rename(&partial, &target)
            .and_then(|()| fs::write(layout.at("current"), &release.version))
            .map_err(|error| (Failure::Start, format!("install: {error}")))?;
        Ok(release.version)
    }

    async fn download_all(
        &self,
        release: &Release,
        layout: &Layout,
    ) -> Result<Vec<PathBuf>, (Failure, String)> {
        let parts: [&Part; 3] = [&release.node, &release.postgres, &release.server];
        let total: u64 = parts.iter().map(|part| part.size).sum();
        let done = Arc::new(Mutex::new([0u64; 3]));
        let mut files = Vec::new();
        for (index, part) in parts.into_iter().enumerate() {
            let done = done.clone();
            let status = self.status.clone();
            let mut arrived = move |bytes: u64| {
                let mut done = done.lock().unwrap();
                done[index] = bytes;
                let percent = (done.iter().sum::<u64>() * 100 / total.max(1)).min(100) as u8;
                status.send_if_modified(|status| {
                    let changed = *status != Status::Downloading(percent);
                    *status = Status::Downloading(percent);
                    changed
                });
            };
            let file = stack_fetch::download(part, &layout.at("downloads"), &mut arrived)
                .await
                .map_err(|error| match error {
                    FetchError::Io(error) => (Failure::Start, format!("download: {error}")),
                    other => (Failure::Download, other.to_string()),
                })?;
            files.push(file);
        }
        Ok(files)
    }

    /// Postgres (made on the first start), the migrations, then the three server processes.
    async fn run(&self, plan: &Plan, layout: &Layout, launch: &Arc<Launch>) -> Result<(), String> {
        let pgdata = layout.at("pgdata");
        if !pgdata.join("PG_VERSION").exists() {
            self.initdb(plan, layout, launch).await?;
        }
        self.keep(plan.postgres(&pgdata), launch).await?;
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

/// The version recorded as installed, if its folder is there.
fn installed(layout: &Layout) -> Option<String> {
    let version = fs::read_to_string(layout.at("current")).ok()?;
    let version = version.trim();
    layout.version(version).is_dir().then(|| version.to_owned())
}

async fn read_manifest(address: &str) -> Result<String, String> {
    if let Some(path) = address
        .strip_prefix("file://")
        .or_else(|| Path::new(address).is_absolute().then_some(address))
    {
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
            grace: Duration::from_secs(30),
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
        ];
        self.pg_spec("postgres", args.map(str::to_owned).to_vec(), vec![])
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
        }
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
        env
    }

    fn api(&self) -> Spec {
        let mut env = self.app();
        env.extend([
            ("API_HOST", "127.0.0.1".into()),
            ("API_PORT", self.ports.api.to_string()),
            ("AUTH_PASSWORD_ENABLED", "true".into()),
            ("AUTH_BREACHED_PASSWORD_CHECK_ENABLED", "false".into()),
        ]);
        self.node_spec("api", env)
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

    const LOOP: &str = "trap 'exit 0' TERM INT; while :; do sleep 0.05; done";

    /// An installed version whose programs are shell scripts that write what they are to `said`.
    fn installed_fakes(root: &Path, said: &Path, migrate_exit: u8) {
        let version = root.join("versions/1");
        let s = said.display();
        script(
            &version.join("node/bin/node"),
            &format!(
                "echo \"$1\" >> {s}; case \"$1\" in migrate.js) exit {migrate_exit};; esac; {LOOP}"
            ),
        );
        let pg = version.join("postgres/bin");
        script(
            &pg.join("postgres"),
            &format!("echo postgres >> {s}; {LOOP}"),
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
            r#"{"version":"1","entrypoints":{"migrate":"migrate.js","api":"api.js","worker":"worker.js","web":"web.js"}}"#,
        )
        .unwrap();
        fs::write(root.join("current"), "1").unwrap();
    }

    fn options() -> Options {
        Options {
            manifest: "file:///nowhere/manifest.json".into(),
            hosted_login_issuer: None,
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
        assert_eq!(first[..4], ["initdb", "postgres", "createdb", "migrate.js"]);
        let mut rest = first[4..].to_vec();
        rest.sort();
        assert_eq!(rest, ["api.js", "web.js", "worker.js"]);
        // The folder is held while it runs.
        assert!(
            stack_setup::lock(&root.join("stack.lock"))
                .unwrap()
                .is_none()
        );
        assert!(local.stop().await);
        assert_eq!(*local.status().borrow(), Status::Off);
        assert!(
            stack_setup::lock(&root.join("stack.lock"))
                .unwrap()
                .is_some()
        );

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
    async fn a_failed_migration_stops_postgres_and_says_so() {
        let root = scratch("migrate-fails");
        let said = root.join("said");
        installed_fakes(&root, &said, 1);
        let local = Local::new(Arc::new(Said(said.clone())));
        local.start(Layout(root.clone()), options()).await;
        assert_eq!(settled(&local).await, Status::Failed(Failure::Start));
        assert!(!lines_of(&said).iter().any(|line| line == "api.js"));
        // Postgres was stopped and the folder released.
        assert!(
            stack_setup::lock(&root.join("stack.lock"))
                .unwrap()
                .is_some()
        );
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

    /// The real bundle, end to end, without a window: `tests/stack_e2e.sh` runs this with
    /// `DOZO_STACK_E2E_MANIFEST` (a local manifest) and `DOZO_STACK_E2E_ROOT` (an empty folder).
    /// Installs, starts, checks `/health`, stops, and checks no process of it is left.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "needs a built server bundle; run by tests/stack_e2e.sh"]
    async fn e2e_installs_starts_and_stops_the_real_server() {
        let (local, root, ports) = e2e_ready().await;
        assert!(answers_200(ports.api, "/health"));
        e2e_this_computer_connects(&root, ports).await;
        assert!(local.stop().await, "a process had to be killed");
        let left = processes_under(&root);
        assert!(left.is_empty(), "still running after stop: {left:?}");
        println!("E2E: stopped, no process left");
    }

    /// Starts the real server and waits to be killed (`tests/stack_e2e.sh` kills it with
    /// SIGKILL, then checks that every process of the server ended with it).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "needs a built server bundle; run by tests/stack_e2e.sh"]
    async fn e2e_hold_until_killed() {
        let (_local, _root, _ports) = e2e_ready().await;
        println!("E2E: holding");
        tokio::time::sleep(Duration::from_secs(600)).await;
    }

    async fn e2e_ready() -> (Arc<Local>, PathBuf, Ports) {
        let root = PathBuf::from(std::env::var("DOZO_STACK_E2E_ROOT").unwrap());
        let options = Options {
            manifest: std::env::var("DOZO_STACK_E2E_MANIFEST").unwrap(),
            hosted_login_issuer: None,
        };
        let local = Local::new(Arc::new(RealChecks));
        let started = std::time::Instant::now();
        let mut seen = local.status();
        local.start(Layout(root.clone()), options).await;
        let status = loop {
            let status = seen.borrow_and_update().clone();
            println!("E2E: {:?} at {} ms", status, started.elapsed().as_millis());
            if matches!(status, Status::Ready(_) | Status::Failed(_)) {
                break status;
            }
            seen.changed().await.unwrap();
        };
        let Status::Ready(url) = status else {
            panic!("did not start: {status:?}; see {}/logs", root.display());
        };
        println!(
            "E2E: ready {url} after {} ms",
            started.elapsed().as_millis()
        );
        let ports = stack_setup::saved_ports(&root.join("ports")).unwrap();
        (local, root, ports)
    }

    /// "Let Bots Use This Computer" against this server: sign up, pair with the app's own pairing
    /// code, connect with its socket, and see the server list this computer as connected.
    async fn e2e_this_computer_connects(root: &Path, ports: Ports) {
        use crate::device_pairing::{Outcome, Pairing, Secrets as Keys, SignIn};
        struct Keyring(Mutex<std::collections::HashMap<String, String>>);
        impl Keys for Keyring {
            fn get(&self, account: &str) -> Result<Option<String>, String> {
                Ok(self.0.lock().unwrap().get(account).cloned())
            }
            fn set(&self, account: &str, secret: &str) -> Result<(), String> {
                self.0.lock().unwrap().insert(account.into(), secret.into());
                Ok(())
            }
            fn delete(&self, account: &str) -> Result<(), String> {
                self.0.lock().unwrap().remove(account);
                Ok(())
            }
        }
        struct Cookie(String);
        impl SignIn for Cookie {
            async fn cookies(&self, _: &tauri::Url) -> Option<String> {
                Some(self.0.clone())
            }
        }
        let web = tauri::Url::parse(&format!("http://127.0.0.1:{}/", ports.web)).unwrap();
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::new();
        let signup = client
            .post(web.join("/api/auth/sign-up/email").unwrap())
            .header("content-type", "application/json")
            .header("origin", web.as_str().trim_end_matches('/'))
            .body(r#"{"email":"owner@example.test","password":"e2e-Password-123","name":"Owner"}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(signup.status(), 200, "sign-up");
        let cookie = signup
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|value| value.to_str().ok()?.split(';').next().map(str::to_owned))
            .collect::<Vec<_>>()
            .join("; ");
        let pairing = Pairing::new(
            web.clone(),
            root.join("e2e-devices"),
            Arc::new(Keyring(Mutex::default())),
        );
        pairing.allow().unwrap();
        let outcome = pairing.pair(&Cookie(cookie.clone())).await;
        let Ok(Outcome::Connected(token)) = outcome else {
            panic!("pairing: {outcome:?}");
        };
        println!("E2E: paired this computer");
        let (stop, stopped) = watch::channel(false);
        let options = crate::device_socket::Options {
            server: web.clone(),
            token,
            runner: crate::device_run::Runner::new(root.join("e2e-computers"), root.to_owned()),
            retry: (Duration::from_millis(200), Duration::from_secs(2)),
            grace: Duration::from_secs(1),
        };
        let socket = tokio::spawn(crate::device_socket::run(options, stopped));
        let devices = web.join("/api/devices").unwrap();
        let connected = wait_until(Duration::from_secs(20), move || {
            let list = std::process::Command::new("curl")
                .args(["-fsS", "-H", &format!("cookie: {cookie}"), devices.as_str()])
                .output();
            list.is_ok_and(|out| {
                String::from_utf8_lossy(&out.stdout).contains(r#""connected":true"#)
            })
        })
        .await;
        let _ = stop.send(true);
        let _ = socket.await;
        assert!(
            connected,
            "the server never listed this computer as connected"
        );
        println!("E2E: this computer connected over the device socket");
    }

    /// Processes whose program or command line is in the server's folder.
    fn processes_under(root: &Path) -> Vec<String> {
        let root = root.to_string_lossy().into_owned();
        let me = std::process::id().to_string();
        fs::read_dir("/proc")
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                let name = path.file_name().unwrap().to_string_lossy();
                name.chars().all(|c| c.is_ascii_digit()) && name != me
            })
            .filter_map(|path| {
                let program = fs::read_link(path.join("exe")).unwrap_or_default();
                let cmdline = fs::read(path.join("cmdline")).unwrap_or_default();
                let cmdline = String::from_utf8_lossy(&cmdline).replace('\0', " ");
                (program.starts_with(&root) || cmdline.contains(&root))
                    .then(|| format!("{}: {cmdline}", path.display()))
            })
            .collect()
    }
}
