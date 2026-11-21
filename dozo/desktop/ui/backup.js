// The Back Up and Restore window. Only this page can call these commands
// (capabilities/backup.json); it never sees a file's path, only its name.
const invoke = window.__TAURI_INTERNALS__.invoke;
const el = (id) => document.getElementById(id);
const mode = { "?restore": "restore", "?reset": "reset" }[location.search] ?? "backup";
const SCREENS = ["backup", "restore", "reset", "working", "done"];
const TITLES = { backup: "Back Up", restore: "Restore", reset: "Reset Password" };

function show(screen) {
  for (const id of SCREENS) el(id).hidden = id !== screen;
}

function problem(form, text) {
  show(form);
  el(form).querySelector(".problem").textContent = text;
}

el("backup").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = el("password").value;
  if (password.length < 8) return problem("backup", "Use at least 8 characters.");
  if (password !== el("again").value) return problem("backup", "The passwords differ.");
  el("step").textContent = "Backing up…";
  show("working");
  try {
    const saved = await invoke("back_up", { password });
    if (!saved) return problem("backup", "");
    el("result").textContent = "Backed up.";
    show("done");
  } catch (reason) {
    problem("backup", String(reason));
  }
});

el("pick").addEventListener("click", async () => {
  const name = await invoke("restore_pick").catch(() => null);
  if (!name) return;
  el("picked").textContent = name;
  el("unlock").hidden = false;
  el("key").focus();
});

el("restore").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = el("key").value;
  if (!password) return;
  el("step").textContent = "Restoring…";
  show("working");
  try {
    await invoke("restore", { password });
    el("result").textContent = "Restored.";
    show("done");
  } catch (reason) {
    problem("restore", String(reason));
  }
});

// A new password for the account here; the main window then asks to sign in with it.
el("reset").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = el("new").value;
  if (password.length < 8) return problem("reset", "Use at least 8 characters.");
  if (password !== el("new-again").value) return problem("reset", "The passwords differ.");
  el("step").textContent = "Resetting…";
  show("working");
  try {
    await invoke("reset_password", { password });
    el("result").textContent = "Password reset.";
    show("done");
  } catch (reason) {
    problem("reset", String(reason));
  }
});

document.title = TITLES[mode];
show(mode);
(({ restore: el("pick"), reset: el("new") })[mode] ?? el("password")).focus();
