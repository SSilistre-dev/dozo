import { mkdirSync, writeFileSync } from "node:fs";
import type { BrowserContext, Download, Page } from "@playwright/test";

/**
 * What a person can read or copy on a screen, checked for the upstream project's name and links.
 * Everything here is observable through the browser; nothing reads the app's source.
 */

/** The upstream name and the places it was published. A hit anywhere a person can read is a leak. */
const LEAK = /rakazo|getrakazo|elie222|RWwKa2Sn7h|id6801531099/i;

/**
 * Deliberately unchanged technical identifiers, allowed ONLY inside attribute and link values
 * (never in visible text): `@rakazo/*`, `RAKAZO_*`, `x-rakazo-*` and the `rakazo://` scheme.
 * Global on purpose: every occurrence in a value is exempt, not just the first.
 */
const KNOWN_IDENTIFIERS = [
  /@rakazo\/[\w.-]+/gi,
  /RAKAZO_\w+/g,
  /x-rakazo-[\w-]+/gi,
  /rakazo:\/\//gi,
];

/** The documented attribution phrases (the NOTICE file): the one place the name may show. */
const ATTRIBUTION = [/fork of Rakazo/gi, /Based on Rakazo/gi, /forked from Rakazo/gi];

export type Leak = { surface: string; where: string; text: string };

export type Scan = {
  /** Strings, attributes and links looked at. */
  elements: number;
  leaks: Leak[];
  /** Hosts that links, images and scripts on the page point at, other than the app's own. */
  hosts: string[];
  /** The same, as host and path without the query. */
  urls: string[];
};

const PROBES = () => {
  const store = { transient: [] as string[], clipboard: [] as string[], opened: [] as string[] };
  (window as unknown as { __dozo: typeof store }).__dozo = store;
  const SELECTOR =
    '[role="status"],[role="alert"],[role="alertdialog"],[role="dialog"],[role="menu"],[role="tooltip"],[data-sonner-toast],[data-slot*="toast"],[data-slot*="tooltip"]';
  const remember = (el: Element | null | undefined) => {
    const holder = el?.closest?.(SELECTOR);
    const text = holder?.textContent?.replace(/\s+/g, " ").trim();
    if (text && !store.transient.includes(text)) store.transient.push(text.slice(0, 2000));
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      remember(
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement,
      );
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        remember(node);
        for (const inner of node.querySelectorAll(SELECTOR)) remember(inner);
      }
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
  const writeText = async (text: unknown) => {
    store.clipboard.push(String(text));
  };
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText,
        write: async (items: ClipboardItem[]) => {
          for (const item of items) {
            if (item.types.includes("text/plain")) {
              const blob = await item.getType("text/plain");
              store.clipboard.push(await blob.text());
            }
          }
        },
        readText: async () => "",
      },
    });
  } catch {
    // The page keeps its own clipboard; copied strings are then not readable.
  }
  window.open = ((url?: string | URL) => {
    store.opened.push(String(url ?? ""));
    return null;
  }) as typeof window.open;
};

/** Installs the transient-text, clipboard and window.open recorders in every page of the context. */
export async function installProbes(context: BrowserContext) {
  await context.addInitScript(PROBES);
}

type Item = { where: string; text: string };

/**
 * Only carriers a person does not read (`href`, `src`, `action`, `meta[...]`, a URL passed to
 * `window.open`) may hold an identifier. Anything a person reads, hears or copies (title, body
 * text, input values, `alt`, `title`, `placeholder` and `aria-*` attributes, toasts, clipboard,
 * downloads, text passed to `scanStrings`) may not.
 */
const isAttributeOrLink = (where: string) =>
  /^[\w-]*\[(href|src|action)\]$/.test(where) ||
  /^meta\[[^\]]+\]$/.test(where) ||
  where === "window.open";

function scanText(surface: string, items: Item[]): Scan["leaks"] {
  const leaks: Leak[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let text = item.text;
    if (isAttributeOrLink(item.where)) {
      for (const known of KNOWN_IDENTIFIERS) text = text.replace(known, "");
    }
    for (const phrase of ATTRIBUTION) text = text.replace(phrase, "");
    const match = LEAK.exec(text);
    if (!match) continue;
    const start = Math.max(0, match.index - 30);
    const snippet = text.slice(start, match.index + 40).replace(/\s+/g, " ");
    const key = `${item.where}|${snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leaks.push({ surface, where: item.where, text: snippet });
  }
  return leaks;
}

/** Visible text, hidden text, readable attributes, links, transient messages and copied strings. */
export async function scanPage(page: Page, surface: string): Promise<Scan> {
  const found = await page.evaluate(() => {
    const items: { where: string; text: string }[] = [];
    const hosts = new Set<string>();
    const urls = new Set<string>();
    items.push({ where: "title", text: document.title });
    items.push({ where: "body.innerText", text: document.body?.innerText ?? "" });
    if (document.body) {
      const clone = document.body.cloneNode(true) as HTMLElement;
      for (const el of clone.querySelectorAll("script,style,noscript,template")) el.remove();
      items.push({
        where: "body.textContent(hidden text included)",
        text: clone.textContent ?? "",
      });
    }
    for (const attr of [
      "alt",
      "title",
      "aria-label",
      "aria-description",
      "placeholder",
      "aria-placeholder",
    ]) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        items.push({ where: `[${attr}]`, text: el.getAttribute(attr) ?? "" });
      }
    }
    for (const el of document.querySelectorAll("input,textarea")) {
      const value = (el as HTMLInputElement).value;
      if (value && (el as HTMLInputElement).type !== "password")
        items.push({ where: "input.value", text: value });
    }
    for (const meta of document.querySelectorAll("meta[content]")) {
      items.push({
        where: `meta[${meta.getAttribute("name") ?? meta.getAttribute("property")}]`,
        text: meta.getAttribute("content") ?? "",
      });
    }
    for (const el of document.querySelectorAll("[href],[src],[action]")) {
      const raw =
        el.getAttribute("href") ?? el.getAttribute("src") ?? el.getAttribute("action") ?? "";
      if (!raw || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("blob:"))
        continue;
      items.push({
        where: `${el.tagName.toLowerCase()}[${el.hasAttribute("href") ? "href" : el.hasAttribute("src") ? "src" : "action"}]`,
        text: raw,
      });
      try {
        const url = new URL(raw, location.href);
        if (/^https?:$/.test(url.protocol) && url.host !== location.host) {
          hosts.add(url.host);
          urls.add(`${url.host}${url.pathname}`.replace(/\/$/, ""));
        }
        if (url.protocol === "mailto:") hosts.add(`mailto:${url.pathname.split("@")[1] ?? ""}`);
      } catch {
        // not a URL
      }
    }
    const store = (
      window as unknown as {
        __dozo?: { transient: string[]; clipboard: string[]; opened: string[] };
      }
    ).__dozo;
    for (const text of store?.transient ?? [])
      items.push({ where: "transient (toast, dialog, menu, tooltip)", text });
    for (const text of store?.clipboard ?? []) items.push({ where: "clipboard", text });
    for (const url of store?.opened ?? []) {
      items.push({ where: "window.open", text: url });
      try {
        const opened = new URL(url, location.href);
        hosts.add(opened.host);
        urls.add(`${opened.host}${opened.pathname}`.replace(/\/$/, ""));
      } catch {
        // not a URL
      }
    }
    return { items, hosts: [...hosts], urls: [...urls] };
  });
  return {
    elements: found.items.length,
    leaks: scanText(surface, found.items),
    hosts: found.hosts,
    urls: found.urls,
  };
}

/** A downloaded file: its name and, for text or archives, the bytes a person would open. */
export async function scanDownload(surface: string, download: Download): Promise<Scan> {
  const name = download.suggestedFilename();
  const path = await download.path();
  const items: Item[] = [{ where: "download.filename", text: name }];
  if (path) {
    const { readFileSync, statSync } = await import("node:fs");
    // Zip entry names are stored uncompressed, so a latin1 view of the archive shows them.
    if (statSync(path).size < 20 * 1024 * 1024)
      items.push({ where: "download.content", text: readFileSync(path).toString("latin1") });
  }
  return { elements: items.length, leaks: scanText(surface, items), hosts: [], urls: [] };
}

/** Scans text produced outside the page (an exported file read by the test, an API answer). */
export function scanStrings(surface: string, where: string, texts: string[]): Scan {
  return {
    elements: texts.length,
    leaks: scanText(
      surface,
      texts.map((text) => ({ where, text })),
    ),
    hosts: [],
    urls: [],
  };
}

export function mergeScans(...scans: Scan[]): Scan {
  const leaks: Leak[] = [];
  const seen = new Set<string>();
  for (const leak of scans.flatMap((scan) => scan.leaks)) {
    const key = `${leak.surface}|${leak.where}|${leak.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      leaks.push(leak);
    }
  }
  return {
    elements: scans.reduce((sum, scan) => sum + scan.elements, 0),
    leaks,
    hosts: [...new Set(scans.flatMap((scan) => scan.hosts))],
    urls: [...new Set(scans.flatMap((scan) => scan.urls))],
  };
}

export type CoverageRecord = {
  surface: string;
  group: string;
  theme: string;
  covers: string[];
  visited: boolean;
  elements: number;
  leaks: Leak[];
  hosts: string[];
  urls: string[];
  serverErrors: string[];
  note?: string;
};

export function outDir() {
  return process.env.DOZO_E2E_OUT ?? ".out";
}

export function writeCoverage(record: CoverageRecord) {
  const dir = `${outDir()}/coverage`;
  mkdirSync(dir, { recursive: true });
  const slug = `${record.theme}-${record.surface}`.replace(/[^\w.-]+/g, "_");
  writeFileSync(`${dir}/${slug}.json`, JSON.stringify(record));
}
