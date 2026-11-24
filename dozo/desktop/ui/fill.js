// The question before a login is first filled on a site. Cancel comes first and has the focus, so
// Enter and Escape both cancel; only a click on Allow allows. Every word comes from the app. Only
// this page can call these commands (capabilities/fill.json).
const invoke = window.__TAURI_INTERNALS__.invoke;
const el = (id) => document.getElementById(id);
const shown = await invoke("fill_question").catch(() => null);
// The answer names the question this window shows, so it never lands on a later one.
// (Ids start at 1: with nothing shown, id 0 answers nothing.)
const answer = (allow) =>
  invoke("fill_answer", { id: shown?.id ?? 0, allow }).catch(() => undefined);
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
  // Nothing is being asked (it was cancelled while this opened).
  answer(false);
}
