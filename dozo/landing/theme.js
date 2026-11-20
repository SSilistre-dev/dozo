/* Dozo site theme, shared by every page; loaded in <head> so the page paints in its theme. Without
   ?theme=light or ?theme=dark in the address the page follows the system's scheme, also when it
   changes. The header button makes a choice that beats the system; it travels in the address of the
   page and of its links to the site's other pages: nothing is stored. */
{
  const root = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: light)");
  let chosen = new URLSearchParams(location.search).get("theme");
  if (chosen !== "light" && chosen !== "dark") chosen = null;
  const apply = (light) => {
    if (light) root.dataset.theme = "light";
    else delete root.dataset.theme;
  };
  apply(chosen ? chosen === "light" : system.matches);
  system.addEventListener("change", (e) => {
    if (!chosen) apply(e.matches);
  });
  const carry = (url) => {
    if (chosen) url.searchParams.set("theme", chosen);
    else url.searchParams.delete("theme");
    return url.href;
  };
  addEventListener("DOMContentLoaded", () => {
    const pages = [...document.querySelectorAll("a[href]")].filter((a) => {
      const url = new URL(a.href);
      return url.origin === location.origin && !(url.hash && url.pathname === location.pathname);
    });
    const follow = () => {
      for (const a of pages) a.href = carry(new URL(a.href));
    };
    follow();
    document.getElementById("theme").addEventListener("click", () => {
      chosen = root.dataset.theme === "light" ? "dark" : "light";
      apply(chosen === "light");
      history.replaceState(history.state, "", carry(new URL(location.href)));
      follow();
    });
  });
}
