// The app's own screens. Only these pages can call the app (capabilities/local.json); a page
// loaded from a server cannot.
const invoke = window.__TAURI_INTERNALS__.invoke;
const DEFAULT_SERVER = "https://app.dozo.bot";
const SCREENS = ["choose", "connecting", "setting-up", "failed", "unreachable"];
// The one line shown while the server on this computer is set up.
const STEPS = {
  downloading: ({ percent }) => `Downloading ${percent}%`,
  preparing: () => "Preparing",
  starting: () => "Starting",
};
const el = (id) => document.getElementById(id);
let waiting;

function show(screen, server) {
  clearTimeout(waiting);
  for (const id of SCREENS) el(id).hidden = id !== screen;
  if (server)
    for (const host of document.querySelectorAll(".host")) host.textContent = new URL(server).host;
}

function chooseServer(server) {
  el("address").value = server ?? DEFAULT_SERVER;
  el("invalid").textContent = "";
  show("choose");
  el("address").focus();
  el("address").select();
}

async function connect(server) {
  show("connecting", server);
  // The server's page replaces this one when it arrives. Still here after a while: it did not.
  waiting = setTimeout(() => show("unreachable", server), 20_000);
  if (!(await invoke("connect"))) show("unreachable", server);
}

async function save(address) {
  try {
    connect(await invoke("set_server", { address }));
  } catch (reason) {
    el("invalid").textContent = reason;
  }
}

// The server on this computer: the app downloads, sets up and starts it; this follows along. Each
// answer comes once the step changes, so nothing here runs on a timer.
async function setUp() {
  el("step").textContent = "";
  show("setting-up");
  let seen = null;
  for (;;) {
    const status = await invoke("local_progress", { seen });
    seen = status;
    if (status.state === "ready") return connect(status.url);
    if (status.state === "off") return chooseServer(await invoke("current_server"));
    if (status.state === "failed") {
      el("failure").textContent = status.message;
      return show("failed");
    }
    el("step").textContent = STEPS[status.state](status);
  }
}

async function useThisComputer() {
  try {
    await invoke("use_this_computer");
    setUp();
  } catch (reason) {
    el("invalid").textContent = reason;
  }
}

el("choose").addEventListener("submit", (event) => {
  event.preventDefault();
  save(el("address").value);
});
el("this-computer").addEventListener("click", useThisComputer);
el("local-retry").addEventListener("click", useThisComputer);
el("local-change").addEventListener("click", async () =>
  chooseServer(await invoke("current_server")),
);
el("retry").addEventListener("click", async () => connect(await invoke("current_server")));
el("change").addEventListener("click", async () => chooseServer(await invoke("current_server")));

const server = await invoke("current_server");
const here = await invoke("local_progress", { seen: null });
if (location.search === "?change") chooseServer(server);
else if (here.state !== "off") setUp();
else if (server) connect(server);
else chooseServer(server);
