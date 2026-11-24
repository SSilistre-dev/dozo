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

// The logins of the password manager, shown only while it is on. Every word comes from the app.
function note(text) {
  el("login-note").hidden = !text;
  el("login-note").textContent = text ?? "";
}

function names(item) {
  const title = document.createElement("span");
  title.textContent = item.title;
  const site = document.createElement("span");
  site.className = "site";
  site.textContent = item.site.replace(/^https:\/\//, "");
  return [title, site];
}

// A login the picker offers: the whole row picks it.
function offered(item, onPick) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.append(...names(item));
  button.addEventListener("click", async () => {
    button.disabled = true;
    await onPick();
    button.disabled = false;
  });
  li.append(button);
  return li;
}

// A login that is linked, with the one thing to do to it.
function linked(item, remove, onRemove) {
  const li = document.createElement("li");
  li.className = "linked";
  const info = document.createElement("span");
  info.className = "info";
  info.append(...names(item));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "plain";
  button.textContent = remove;
  button.setAttribute("aria-label", `${remove} ${item.title}`);
  button.addEventListener("click", async () => {
    button.disabled = true;
    await onRemove();
    button.disabled = false;
  });
  li.append(info, button);
  return li;
}

function renderLogins(logins) {
  const section = el("logins");
  section.hidden = !logins;
  if (!logins) {
    el("candidates").hidden = true;
    note(null);
    return;
  }
  el("logins-heading").textContent = logins.heading;
  el("link-login").textContent = logins.link;
  el("link-login").onclick = async () => {
    note(null);
    el("link-login").disabled = true;
    try {
      const found = await invoke("logins_candidates");
      el("candidates").replaceChildren(
        ...found.map((item) =>
          offered(item, async () => {
            try {
              await invoke("logins_link", { item: item.item });
              el("candidates").hidden = true;
            } catch (error) {
              note(String(error));
            }
          }),
        ),
      );
      el("candidates").hidden = false;
      if (found.length === 0) note(logins.none);
    } catch (error) {
      el("candidates").hidden = true;
      note(String(error));
    }
    el("link-login").disabled = false;
  };
  el("links").replaceChildren(
    ...logins.items.map((item) =>
      linked(item, logins.remove, async () => {
        await invoke("logins_remove", { handle: item.handle }).catch((error) => note(String(error)));
      }),
    ),
  );
  el("links").hidden = logins.items.length === 0;
}

function render(list) {
  document.documentElement.lang = list.lang;
  document.title = list.title;
  el("version").textContent = list.version;
  // Keeps focus on the row that had it, as the list is drawn again.
  const focused = document.activeElement?.dataset?.id;
  el("rows").replaceChildren(...list.rows.map(row));
  renderLogins(list.logins);
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
