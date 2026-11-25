// The question before a switch a server's page asked for is changed (src/page_bridge.rs). The
// person did not open it, so it must not take a key meant for something else: Cancel comes first
// and has the focus, Enter and Escape both cancel, and Turn On answers only after the window has
// been in front for a moment.
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
  // Turn On answers only once the window has been on screen and in front for a moment, and goes
  // grey again whenever it loses the focus.
  let arming;
  const arm = () => {
    clearTimeout(arming);
    el("allow").disabled = true;
    if (document.visibilityState === "visible" && document.hasFocus()) {
      arming = setTimeout(() => {
        el("allow").disabled = false;
      }, 1000);
    }
  };
  addEventListener("focus", arm);
  addEventListener("blur", arm);
  document.addEventListener("visibilitychange", arm);
  arm();
} else {
  // Nothing is being asked (it ended while this opened).
  answer(false);
}
