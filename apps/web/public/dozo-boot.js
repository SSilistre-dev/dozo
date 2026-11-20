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
  const [DEFAULT, MIN, MAX, MINI, CHAT] = [288, 240, 480, 72, 320];
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

// The shell goes when the app's code runs (src/lib/dozo-boot.ts), so a load where that code never
// runs would leave it up for good: the entry script failed (a network change drops its chunks, a
// deploy removed them) or it hangs. A failed load reloads once, unless it did so in the last 30
// seconds or the browser is offline; then, as after STALL_MS without the code, the shell says the
// server cannot be reached and offers a retry, as it does when the app finds no language catalog.
// The text is the app's own for that case (SessionUnavailable in src/App.tsx); a test holds it equal
// to the catalogs.
(() => {
  const STALL_MS = 15_000;
  const RELOADED_KEY = "dozo:boot-reload";
  const TEXT = {
    de: ["Server nicht erreichbar.", "Jetzt erneut versuchen"],
    en: ["Can't reach the server.", "Retry now"],
    es: ["No se puede alcanzar el servidor.", "Reintentar ahora"],
    fr: ["Impossible d'atteindre le serveur.", "Réessayer maintenant"],
    he: ["אין גישה לשרת.", "לנסות שוב עכשיו"],
    hi: ["सर्वर तक नहीं पहुंचा जा सका।", "अभी पुनः प्रयास करें"],
    ja: ["サーバーに接続できません。", "今すぐ再試行"],
    ko: ["서버에 연결할 수 없습니다.", "지금 다시 시도"],
    nl: ["De server is niet bereikbaar.", "Nu opnieuw proberen"],
    pl: ["Nie można połączyć się z serwerem.", "Ponów teraz"],
    "pt-BR": ["Não é possível acessar o servidor.", "Nova tentativa agora"],
    ru: ["Не удаётся связаться с сервером.", "Повторить попытку сейчас"],
    tr: ["Sunucuya ulaşılamıyor.", "Şimdi tekrar dene"],
    "zh-CN": ["无法连接服务器。", "立即重试"],
    "zh-TW": ["無法連線伺服器。", "立即重試"],
  };
  // The app's order (src/lib/ui-locale.ts): the saved choice, then the browser's language.
  const text = () => {
    let wanted = "";
    try {
      wanted = localStorage.getItem("rakazo.uiLocale") || "";
    } catch {}
    wanted = wanted || navigator.language || "";
    const lower = wanted.toLowerCase();
    const exact = Object.keys(TEXT).find((key) => key.toLowerCase() === lower);
    if (exact) return TEXT[exact];
    if (lower.startsWith("zh")) return /hant|tw|hk|mo/.test(lower) ? TEXT["zh-TW"] : TEXT["zh-CN"];
    if (lower.startsWith("pt")) return TEXT["pt-BR"];
    return TEXT[lower.split("-")[0]] || TEXT.en;
  };
  const offer = () => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", offer, { once: true });
      return;
    }
    // The app removes the shell once it runs; a failure it meets later brings the shell back.
    let shell = document.getElementById("dozo-boot");
    if (!shell) {
      shell = document.createElement("div");
      shell.id = "dozo-boot";
      document.body.append(shell);
    }
    if (shell.dataset.state === "unreachable") return;
    const [message, retry] = text();
    const box = document.createElement("section");
    const line = document.createElement("p");
    const button = document.createElement("button");
    line.textContent = message;
    button.type = "button";
    button.textContent = retry;
    button.addEventListener("click", () => location.reload());
    box.append(line, button);
    shell.append(box);
    shell.removeAttribute("aria-hidden");
    shell.dataset.state = "unreachable";
  };
  const failed = () => {
    let last = Number.NaN;
    try {
      last = Number(sessionStorage.getItem(RELOADED_KEY) || 0);
      if (navigator.onLine !== false && !(Date.now() - last < 30_000)) {
        sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
        location.reload();
        return;
      }
    } catch {}
    offer();
  };
  const onError = (event) => {
    const target = event.target;
    if (target instanceof HTMLScriptElement && target.type === "module") failed();
  };
  document.addEventListener("error", onError, true);
  const timer = setTimeout(offer, STALL_MS);
  // Called by the app's code: when no language catalog can load (src/lib/dozo-boot-deadline.ts).
  window.dozoBootUnreachable = offer;
  // Called by the app's code as it starts running.
  window.dozoBootStarted = () => {
    clearTimeout(timer);
    document.removeEventListener("error", onError, true);
  };
})();
