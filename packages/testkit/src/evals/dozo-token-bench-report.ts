import type { TokenBenchReport } from "./dozo-token-bench.js";
import { COMPONENTS } from "./dozo-token-bench.js";
import type { EvalPricing } from "./measurement.js";
import { validatePricing } from "./measurement.js";

const KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** The verdict line the make target ends with. */
export function summaryLine(report: TokenBenchReport) {
  const t = report.totals;
  return `TOKEN: giris=${t.promptTokens} cikis=${t.outputTokens} onbellek_okuma=%${Math.round(t.cacheReadShare * 100)}`;
}

/** The largest input components across the task set, largest first. */
export function topComponents(report: TokenBenchReport, count = 3) {
  return COMPONENTS.map((c) => ({ component: c, tokens: report.totals.components[c] }))
    .sort((a, b) => b.tokens - a.tokens || a.component.localeCompare(b.component))
    .slice(0, count);
}

/** Lines describing what changed since the previous baseline; one line when nothing did. */
export function compareTokenReports(previous: unknown, current: TokenBenchReport): string[] {
  const top = topComponents(current)
    .map((c) => `${c.component}=${c.tokens}`)
    .join(" ");
  const old = previous as Partial<TokenBenchReport> | undefined;
  if (!old?.totals || !Array.isArray(old.tasks))
    return ["no previous baseline", `largest input parts: ${top}`];
  const lines: string[] = [];
  if (old.version !== current.version)
    lines.push(`bench version changed: ${old.version} -> ${current.version}`);
  const before = new Map(old.tasks.map((task) => [task.id, task]));
  for (const task of current.tasks) {
    const was = before.get(task.id);
    if (!was) {
      lines.push(`${task.id}: new`);
      continue;
    }
    const changes = KEYS.filter((k) => was[k] !== task[k]).map(
      (k) => `${k} ${was[k]} -> ${task[k]} (${signed(task[k] - was[k])})`,
    );
    if (changes.length) lines.push(`${task.id}: ${changes.join(", ")}`);
    before.delete(task.id);
  }
  for (const id of before.keys()) lines.push(`${id}: removed`);
  const totals = (["promptTokens", ...KEYS] as const)
    .filter((k) => old.totals![k] !== current.totals[k])
    .map((k) => `${k} ${old.totals![k]} -> ${current.totals[k]}`);
  lines.push(
    totals.length ? `total: ${totals.join(", ")}` : "no change from the previous baseline",
  );
  lines.push(`largest input parts: ${top}`);
  return lines;
}

export type BenchCliIo = {
  read: (path: string) => string | undefined;
  write: (path: string, text: string) => void;
  log: (line: string) => void;
  run: (pricing?: EvalPricing) => Promise<TokenBenchReport>;
};

/** `<baseline.json> [pricing.json]`: run, print the difference, rewrite the baseline. Exit code. */
export async function runTokenBenchCli(args: readonly string[], io: BenchCliIo) {
  const [baselinePath, pricingPath] = args;
  if (!baselinePath) {
    io.log("usage: token-kiyas <baseline.json> [pricing.json]");
    return 64;
  }
  const pricingText = pricingPath ? io.read(pricingPath) : undefined;
  if (pricingPath && pricingText === undefined) {
    io.log(`pricing file not readable: ${pricingPath}`);
    return 2;
  }
  const pricing = pricingText ? validatePricing(JSON.parse(pricingText)) : undefined;
  const previousText = io.read(baselinePath);
  let previous: unknown;
  try {
    previous = previousText === undefined ? undefined : JSON.parse(previousText);
  } catch {
    io.log("previous baseline is not JSON; comparing against nothing");
  }
  const report = await io.run(pricing);
  for (const line of compareTokenReports(previous, report)) io.log(line);
  io.write(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  io.log(summaryLine(report));
  return 0;
}
