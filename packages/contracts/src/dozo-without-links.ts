/**
 * Calendar text without its links, as the phone sends it and the server passes it on (a meeting's
 * address often carries its passcode). The text is first normalised (NFKC, so full-width slashes and
 * dots count, and runs of white space become one space); then every link is removed: an address
 * with a scheme (`https://…`, `tel:+1 555 0100,,123456#`, `name:x@y`), a `www.` host, and a host
 * with a path (`zoom.us / j / 123`) or that reads as one (`meet.google.com`, `zoom.us`), each with
 * its query. Text without a link stays as written; nothing guesses at a passcode in words.
 * Undefined when nothing is left.
 */
export function withoutLinks(text: string): string | undefined {
  const kept = text
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(SCHEME, " ")
    .replace(WWW, " ")
    .replace(HOSTED, (match, mail: string | undefined, host: string, path: string) =>
      mail || !(path || readsAsHost(host)) ? match : " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return kept || undefined;
}

/**
 * A scheme, then `//…`, a dial string of five characters or more (spaces, pauses and `#`
 * included, so `Time:10:30` is no link) or a `user@host`.
 */
const SCHEME = /\b[a-z][a-z\d+.-]*:(?:\/\/\S*|\+?\d[\d ().,;#*/-]{3,}[\d#*]|[^\s@:/]+@\S+)/gi;
const WWW = /\bwww\.\S*/gi;
/** A host, an email's local part before it, and its port, path (slashes may be spaced) and query. */
const HOSTED =
  /([^\s@]+@)?\b((?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63})\b((?::\d{2,5})?(?: ?\/ ?[^\s/?#]*)+(?:[?#]\S*)?|(?::\d{2,5})?[?#]\S*)?/gi;

/**
 * A host without a path counts as a link when it has two dots or more (`meet.google.com`), or one
 * dot before a common top-level domain, written in lower case (`zoom.us`). Words with a dot in
 * them (`Node.js`, `ASP.NET`, `St.James`) stay.
 */
function readsAsHost(host: string): boolean {
  const labels = host.split(".");
  if (labels.length > 2) return true;
  return host === host.toLowerCase() && COMMON_TLDS.has(labels[1] ?? "");
}

const COMMON_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "co",
  "us",
  "me",
  "app",
  "dev",
  "ai",
  "gl",
  "ly",
  "to",
  "tv",
  "info",
  "link",
]);
