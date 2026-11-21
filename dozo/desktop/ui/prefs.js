// The Settings window: what the Dozo menu offers now, read again whenever it changes (the answer
// comes when it does; nothing is polled). Picking a row does what picking the menu item does.
// Only this page can call these commands (capabilities/prefs.json).
const invoke = window.__TAURI_INTERNALS__.invoke;
const el = (id) => document.getElementById(id);
let shown = null;

function row({ id, label, on }) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.id = id;
  const text = document.createElement("span");
  text.textContent = label;
  const mark = document.createElement("span");
  if (on === undefined) {
    mark.className = "chevron";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "›";
  } else {
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(on));
    mark.className = "toggle";
  }
  button.append(text, mark);
  button.addEventListener("click", async () => {
    button.disabled = true;
    // A row that is gone by now is simply dropped by the next list.
    await invoke("prefs_pick", { id }).catch(() => undefined);
    button.disabled = false;
  });
  item.append(button);
  return item;
}

function render(list) {
  document.documentElement.lang = list.lang;
  document.title = list.title;
  el("version").textContent = list.version;
  // Keeps focus on the row that had it, as the list is drawn again.
  const focused = document.activeElement?.dataset?.id;
  el("rows").replaceChildren(...list.rows.map(row));
  if (focused) document.querySelector(`[data-id="${CSS.escape(focused)}"]`)?.focus();
}

async function follow() {
  for (;;) {
    try {
      shown = await invoke("prefs_list", { seen: shown });
    } catch {
      return;
    }
    render(shown);
  }
}

follow();
