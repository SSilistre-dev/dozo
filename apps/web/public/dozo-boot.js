// Runs before first paint, after theme.js. On a chat route the boot shell in index.html draws the
// sidebar, at the width this browser last showed; src/lib/dozo-boot.ts removes the shell.
(() => {
  const path = location.pathname;
  const chat =
    path === "/app" || path.startsWith("/app/") || (Boolean(window.rakazoDesktop) && path === "/");
  if (!chat) return;
  const root = document.documentElement;
  root.dataset.dozoBoot = "chat";
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
  const width = Number(saved("rakazo:bots-sidebar-width:"));
  const side =
    saved("rakazo:bots-sidebar-collapsed:") === "1"
      ? 72
      : Number.isFinite(width) && width >= 240
        ? Math.min(width, 480)
        : 240;
  root.style.setProperty("--dozo-boot-side", `${side}px`);
})();
