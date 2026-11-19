import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import type { Measure } from "./budgets";
import { budgetVerdicts, verdictLine } from "./budgets";

/**
 * Writes the live run's report to the output directory: `RAPOR.md` and `rapor.html` (every
 * scenario, its screenshot, the measured budgets) and `verdict.txt`, the last line canli.sh prints.
 * A budget over its limit is a warning in the report, never a failure.
 */
export default class CanliReport implements Reporter {
  private rows: { title: string; status: string; error?: string; shot?: string }[] = [];
  private measures: Measure[] = [];
  private notes: string[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    const title = test.titlePath().slice(3).join(" › ");
    const shot = result.attachments.find((a) => a.name === "shot")?.body?.toString();
    for (const a of test.annotations) {
      if (a.type === "measure" && a.description) this.measures.push(JSON.parse(a.description));
      if (a.type === "note" && a.description) this.notes.push(`${title}: ${a.description}`);
    }
    this.rows.push({
      title,
      status: result.status,
      // A skipped step says why (a server without billing, or the account that could not be made).
      error:
        result.error?.message?.split("\n").slice(0, 6).join(" ").slice(0, 600) ??
        test.annotations.find((a) => a.type === "skip")?.description,
      shot,
    });
  }

  onEnd(result: FullResult) {
    const out = process.env.DOZO_E2E_OUT ?? ".out-canli";
    mkdirSync(out, { recursive: true });
    const counted = this.rows.filter((row) => row.status !== "skipped");
    const failed = counted.filter((row) => row.status !== "passed");
    const pass = result.status === "passed" && failed.length === 0 && counted.length > 0;
    const verdict = verdictLine(pass, counted.length);
    const budgets = budgetVerdicts(this.measures);
    // What the finally step of the account scenarios did (canli/account.spec.ts).
    const cleanup = `${out}/cleanup.json`;
    if (existsSync(cleanup))
      this.notes.push(
        `Temizlik: ${(JSON.parse(readFileSync(cleanup, "utf8")) as { account: string }).account}`,
      );
    const when = new Date().toISOString();
    const md = [
      `# make canli: ${process.env.CANLI_URL ?? "?"}`,
      "",
      `${when}. ${verdict}`,
      "",
      "| Senaryo | Durum | Görüntü |",
      "| --- | --- | --- |",
      ...this.rows.map(
        (row) =>
          `| ${row.title} | ${row.status === "passed" ? "GEÇTİ" : row.status === "skipped" ? `atlandı${row.error ? `: ${row.error.replace(/^atlandı: /, "")}` : ""}` : `KALDI: ${(row.error ?? "").replace(/\|/g, "/")}`} | ${row.shot ? `shots/${row.shot}` : ""} |`,
      ),
      "",
      "## Performans bütçeleri (uyarı, kırmaz)",
      "",
      "| Ölçüm | Değer | Bütçe | Sonuç |",
      "| --- | --- | --- | --- |",
      ...budgets.map(
        (b) =>
          `| ${b.label} | ${b.value} ${b.unit} | ≤ ${b.budget} ${b.unit} | ${b.over ? "UYARI: bütçe aşıldı" : "bütçe içinde"} |`,
      ),
      "",
      ...(this.notes.length ? ["## Notlar", "", ...this.notes.map((n) => `- ${n}`), ""] : []),
    ].join("\n");
    writeFileSync(`${out}/RAPOR.md`, md);
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const html = `<!doctype html><meta charset="utf-8"><title>make canli</title>
<style>body{font:14px system-ui;background:#111;color:#ddd;margin:2rem}td,th{border-bottom:1px solid #333;padding:.4rem;vertical-align:top}img{max-width:420px}</style>
<h1>${esc(verdict)}</h1><p>${esc(process.env.CANLI_URL ?? "")} · ${when}</p>
<table>${this.rows.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.status)}${r.error ? `<br><small>${esc(r.error)}</small>` : ""}</td><td>${r.shot ? `<img src="shots/${esc(r.shot)}">` : ""}</td></tr>`).join("")}</table>
<h2>Performans</h2><table>${budgets.map((b) => `<tr><td>${esc(b.label)}</td><td>${b.value} ${b.unit}</td><td>≤ ${b.budget}</td><td>${b.over ? "UYARI" : "ok"}</td></tr>`).join("")}</table>
${this.notes.length ? `<h2>Notlar</h2><ul>${this.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`;
    writeFileSync(`${out}/rapor.html`, html);
    writeFileSync(`${out}/verdict.txt`, `${verdict}\n`);
    for (const b of budgets.filter((b) => b.over))
      console.log(`canli: UYARI ${b.label} ${b.value} ${b.unit} (bütçe ${b.budget})`);
  }
}
