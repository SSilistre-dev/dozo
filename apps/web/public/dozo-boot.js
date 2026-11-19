// Runs before first paint, after theme.js. On a chat route the boot shell in index.html draws the
// sidebar at the width the app will give it; src/lib/dozo-boot.ts removes the shell. The numbers
// are those of src/lib/bots-sidebar-pref.ts (default, min, max, mini, chat column), which the
// test of this file holds equal.
(() => {
  const path = location.pathname;
  const chat =
    path === "/app" || path.startsWith("/app/") || (Boolean(window.rakazoDesktop) && path === "/");
  if (!chat) return;
  const root = document.documentElement;
  root.dataset.dozoBoot = "chat";
  const [DEFAULT, MIN, MAX, MINI, CHAT] = [240, 240, 480, 72, 320];
  // Saved per user, and the user is not known yet: only a browser with one saved value is read.
  const saved = (prefix) => {
    const values = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) ?? "";
        if (key.startsWith(prefix)) values.push(localStorage.getItem(key));
      }
    } catch {}
    return values.length === 1 ? values[0] : null;
  };
  const stored = Number(saved("rakazo:bots-sidebar-width:"));
  const preferred = Number.isFinite(stored) && stored >= MIN ? stored : DEFAULT;
  const widest = Math.max(MIN, Math.min(MAX, window.innerWidth - CHAT));
  const side =
    saved("rakazo:bots-sidebar-collapsed:") === "1"
      ? MINI
      : Math.max(MIN, Math.min(widest, preferred));
  root.style.setProperty("--dozo-boot-side", `${side}px`);
})();
