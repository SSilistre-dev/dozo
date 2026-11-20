/* Dozo site theme, shared by every page. Dark unless the address says ?theme=light; loaded in
   <head> so the page paints in its theme. The header button switches it, and the choice travels in
   the address of the page and of its links to the site's other pages: nothing is stored. */
{
  const root = document.documentElement;
  if (new URLSearchParams(location.search).get("theme") === "light") root.dataset.theme = "light";
  const carry = (url) => {
    if (root.dataset.theme === "light") url.searchParams.set("theme", "light");
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
      if (root.dataset.theme === "light") delete root.dataset.theme;
      else root.dataset.theme = "light";
      history.replaceState(history.state, "", carry(new URL(location.href)));
      follow();
    });
  });
}
