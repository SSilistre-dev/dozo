// The question an agent on this computer asks before it goes on. Cancel comes first and has the
// focus, so Enter and Escape both refuse, and so does closing the window; only a click on Allow
// allows. The text is shown as text, never as markup. Only this page can call these commands
// (capabilities/agent.json).
const invoke = window.__TAURI_INTERNALS__.invoke;
const el = (id) => document.getElementById(id);
const answer = (allow) => invoke("agent_answer", { allow }).catch(() => undefined);

const shown = await invoke("agent_question").catch(() => null);
if (shown) {
  document.documentElement.lang = shown.lang;
  el("question").textContent = shown.question;
  el("cancel").textContent = shown.cancel;
  el("allow").textContent = shown.allow;
  el("cancel").addEventListener("click", () => answer(false));
  el("allow").addEventListener("click", () => answer(true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") answer(false);
  });
  el("cancel").focus();
} else {
  // Nothing is being asked (it ended while this opened).
  answer(false);
}
