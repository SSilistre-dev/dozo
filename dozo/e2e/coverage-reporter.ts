import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Reporter } from "@playwright/test/reporter";
import { readInventory } from "./inventory";
import { declaredKeysVerdict } from "./logic";
import type { CoverageRecord } from "./scan";
import { NOT_REACHABLE, SKIPS, SURFACES } from "./surfaces";

const out = process.env.DOZO_E2E_OUT ?? ".out";

function pad(text: string, width: number) {
  return text.length >= width
    ? `${text.slice(0, width - 1)}~`
    : text + " ".repeat(width - text.length);
}

/**
 * Prints what the crawl visited: per surface, per inventory key, and the totals. A key that a
 * surface declares in `covers` but that no surface visited FAILS the run (a printed MISSING nobody
 * reads is not a gate). Only checked when every surface ran: a filtered run (DOZO_E2E_ARGS) cannot
 * have visited the rest.
 */
export default class CoverageReporter implements Reporter {
  onEnd(): { status: "failed" } | undefined {
    let failure: { status: "failed" } | undefined;
    const dir = `${out}/coverage`;
    const records: CoverageRecord[] = existsSync(dir)
      ? readdirSync(dir).map(
          (file) => JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as CoverageRecord,
        )
      : [];
    if (records.length === 0) {
      console.log("\nCOVERAGE: no surface was crawled in this run.");
      return undefined;
    }
    const names = [...new Set(records.map((r) => r.surface))];
    const find = (name: string, theme: string) =>
      records.find((r) => r.surface === name && r.theme === theme);
    const mark = (r?: CoverageRecord) =>
      !r ? "-" : r.visited ? (r.leaks.length ? "LEAK" : "yes") : "NO";
    const lines: string[] = [];
    lines.push("", "COVERAGE (surface: visited in light/dark, strings scanned, brand hits)");
    lines.push(
      `${pad("surface", 46)} ${pad("group", 14)} ${pad("light", 5)} ${pad("dark", 5)} ${pad("scanned", 8)} hits`,
    );
    let scanned = 0;
    let hits = 0;
    for (const name of names) {
      const light = find(name, "light");
      const dark = find(name, "dark");
      const elements = (light?.elements ?? 0) + (dark?.elements ?? 0);
      const leaks = (light?.leaks.length ?? 0) + (dark?.leaks.length ?? 0);
      scanned += elements;
      hits += leaks;
      lines.push(
        `${pad(name, 46)} ${pad((light ?? dark)?.group ?? "", 14)} ${pad(mark(light), 5)} ${pad(mark(dark), 5)} ${pad(String(elements), 8)} ${leaks}`,
      );
    }
    const visited = (theme: string) => names.filter((n) => find(n, theme)?.visited).length;
    const ranIn = (theme: string) => names.filter((n) => find(n, theme)).length;
    lines.push(
      `surfaces visited: light ${visited("light")}/${ranIn("light")}, dark ${visited("dark")}/${ranIn("dark")}; strings scanned ${scanned}; brand hits ${hits}`,
    );

    try {
      const inventory = readInventory();
      const visitedKeys = new Set(records.filter((r) => r.visited).flatMap((r) => r.covers));
      lines.push(
        "",
        "INVENTORY (read from the web app source: routes, settings sections, overlays, onboarding steps)",
      );
      let yes = 0;
      let skipped = 0;
      let missing = 0;
      for (const key of inventory.keys) {
        const state = visitedKeys.has(key) ? "visited" : key in SKIPS ? "SKIPPED" : "MISSING";
        if (state === "visited") yes++;
        else if (state === "SKIPPED") skipped++;
        else missing++;
        const why =
          state === "SKIPPED"
            ? `  - ${SKIPS[key]}`
            : state === "MISSING"
              ? "  - not visited in this run"
              : "";
        lines.push(`  ${pad(state, 8)} ${key}${why}`);
      }
      const count = (prefix: string) => inventory.keys.filter((k) => k.startsWith(prefix));
      const share = (prefix: string) =>
        `${count(prefix).filter((k) => visitedKeys.has(k)).length}/${count(prefix).length}`;
      const ranAll = SURFACES.every((s) => records.some((r) => r.surface === s.name));
      const verdict = declaredKeysVerdict(
        ranAll,
        SURFACES.flatMap((s) => s.covers ?? []),
        visitedKeys,
      );
      if (!verdict.checked) {
        lines.push("", "DECLARED KEYS: not checked, not every surface ran (filtered run)");
      } else if (verdict.unvisited.length) {
        lines.push(
          "",
          "DECLARED BUT NOT VISITED (a surface lists the key in `covers`, none reached it)",
        );
        for (const key of verdict.unvisited) lines.push(`  ${key}`);
        failure = { status: "failed" };
      }
      lines.push(
        `inventory: routes ${share("route:")}, settings sections ${share("settings:")}, overlays ${share("overlay:")}, onboarding steps ${share("onboarding:")}; ` +
          `${yes} visited, ${skipped} skipped with a reason, ${missing} missing, of ${inventory.keys.length}`,
      );
    } catch (error) {
      lines.push("", `INVENTORY: unreadable (${(error as Error).message})`);
    }

    const leaks = records.flatMap((r) => r.leaks);
    if (leaks.length) {
      lines.push("", "BRAND LEAKS");
      const seen = new Set<string>();
      for (const leak of leaks) {
        const text = `${leak.surface.replace(/ \((light|dark)\)$/, "")} | ${leak.where} | "${leak.text}"`;
        if (!seen.has(text)) {
          seen.add(text);
          lines.push(`  ${text}`);
        }
      }
    }
    const errors = [
      ...new Set(records.flatMap((r) => r.serverErrors.map((e) => `${e}  (on "${r.surface}")`))),
    ];
    if (errors.length) lines.push("", "SERVER ERRORS SEEN", ...errors.map((e) => `  ${e}`));
    const notes = [...new Set(records.filter((r) => r.note).map((r) => `${r.surface}: ${r.note}`))];
    if (notes.length) lines.push("", "NOTES", ...notes.map((n) => `  ${n}`));
    const urls = [...new Set(records.flatMap((r) => r.urls ?? []))].sort();
    const byHost = new Map<string, string[]>();
    for (const url of urls)
      byHost.set(url.split("/")[0] as string, [
        ...(byHost.get(url.split("/")[0] as string) ?? []),
        url,
      ]);
    lines.push(
      "",
      "OUTGOING LINKS (hosts that links, images and opened windows point at, with up to 4 example paths)",
    );
    for (const [host, list] of byHost)
      lines.push(
        `  ${host} (${list.length}): ${list
          .slice(0, 4)
          .map((u) => u.slice(host.length) || "/")
          .join("  ")}`,
      );
    if (NOT_REACHABLE.length) {
      lines.push("", "NOT REACHABLE (and why)");
      for (const item of NOT_REACHABLE) lines.push(`  ${item.what}: ${item.reason}`);
    }
    console.log(lines.join("\n"));
    return failure;
  }
}
