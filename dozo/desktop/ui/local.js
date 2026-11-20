// The app's own screens. Only these pages can call the app (capabilities/local.json); a page
// loaded from a server cannot.
const invoke = window.__TAURI_INTERNALS__.invoke;
const DEFAULT_SERVER = "https://app.dozo.bot";
const THIS_COMPUTER = "http://127.0.0.1:5173";
const SCREENS = ["choose", "connecting", "unreachable"];
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

el("choose").addEventListener("submit", (event) => {
  event.preventDefault();
  save(el("address").value);
});
el("this-computer").addEventListener("click", () => save(THIS_COMPUTER));
el("retry").addEventListener("click", async () => connect(await invoke("current_server")));
el("change").addEventListener("click", async () => chooseServer(await invoke("current_server")));

const server = await invoke("current_server");
if (server && location.search !== "?change") connect(server);
else chooseServer(server);
