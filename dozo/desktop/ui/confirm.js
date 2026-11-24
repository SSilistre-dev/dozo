// The question before a switch a server's page asked for is turned on (src/page_bridge.rs). The
// person did not open it, so it must not take a key meant for something else: Cancel comes first
// and has the focus, Enter and Escape both cancel, and Turn On answers a click only after a moment.
// Every word comes from the app. Only this page can call these commands (capabilities/confirm.json).
const invoke = window.__TAURI_INTERNALS__.invoke;
const el = (id) => document.getElementById(id);
const answer = (allow) => invoke("confirm_answer", { allow }).catch(() => undefined);

const shown = await invoke("confirm_question").catch(() => null);
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
  setTimeout(() => {
    el("allow").disabled = false;
  }, 1000);
} else {
  // Nothing is being asked (it ended while this opened).
  answer(false);
}
