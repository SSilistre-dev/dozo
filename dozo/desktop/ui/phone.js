// The Connect Phone window. Only this page can call the phone commands (capabilities/phone.json).
const invoke = window.__TAURI_INTERNALS__.invoke;
const SCREENS = ["code", "expired", "signed-out", "failed"];
const el = (id) => document.getElementById(id);
let ticking;

function show(screen) {
  clearInterval(ticking);
  for (const id of SCREENS) el(id).hidden = id !== screen;
}

// Dark modules on white, with the quiet zone of four modules scanners need.
function draw(size, cells) {
  const canvas = el("qr");
  const side = size + 8;
  canvas.width = side;
  canvas.height = side;
  const pen = canvas.getContext("2d");
  pen.fillStyle = "#fff";
  pen.fillRect(0, 0, side, side);
  pen.fillStyle = "#000";
  for (let i = 0; i < cells.length; i++)
    if (cells[i] === "1") pen.fillRect(4 + (i % size), 4 + Math.floor(i / size), 1, 1);
}

// The time left on the code, a clock rather than a data read.
function countdown(expiresAt) {
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (left === 0) return show("expired");
    el("expires").textContent =
      `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  };
  tick();
  ticking = setInterval(tick, 1000);
}

async function newCode() {
  let code;
  try {
    code = await invoke("phone_code");
  } catch {
    return show("failed");
  }
  if (code.state === "signed-out") return show("signed-out");
  draw(code.size, code.cells);
  el("account").textContent = `Signs in as ${code.account}`;
  show("code");
  countdown(code.expiresAt);
}

async function listPhones() {
  const list = el("phones");
  const phones = await invoke("phones").catch(() => []);
  list.replaceChildren(
    ...phones.map(({ channel, pairedAt }) => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      const date = new Date(pairedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      name.textContent = `Phone paired ${date}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        await invoke("remove_phone", { channel }).catch(() => undefined);
        listPhones();
      });
      row.append(name, remove);
      return row;
    }),
  );
  list.hidden = phones.length === 0;
}

el("again").addEventListener("click", newCode);
el("retry").addEventListener("click", newCode);
newCode();
listPhones();
