/**
 * The live run's performance budgets and its verdict line, with no imports so Node's test runner
 * checks them offline (`canli-budgets.test.mjs`, run by `make olc`). A budget only warns: the
 * live site is measured over the public internet from one machine, so a slow minute is not a defect.
 */
export type Measure = { key: string; value: number };

export const BUDGETS: Record<string, { label: string; unit: string; budget: number }> = {
  coldFirstContent: { label: "Soğuk açılış, ilk içerik (FCP, /sign-in)", unit: "ms", budget: 1800 },
  coldAppFirstContent: { label: "Soğuk açılış, ilk içerik (FCP, /app)", unit: "ms", budget: 2500 },
  appsDialog: { label: "Uygulamalar: tıklamadan pencereye", unit: "ms", budget: 600 },
  appsFirstTile: { label: "Uygulamalar: tıklamadan ilk karta", unit: "ms", budget: 1500 },
  modelsResponses: {
    label: "Ayarlar → Modeller: model kataloğu yanıt sayısı",
    unit: "yanıt",
    budget: 8,
  },
};

export type BudgetVerdict = {
  key: string;
  label: string;
  unit: string;
  value: number;
  budget: number;
  over: boolean;
};

/** One row per measured key (the last value wins); unknown keys are reported without a budget. */
export function budgetVerdicts(measures: Measure[]): BudgetVerdict[] {
  const last = new Map<string, number>();
  for (const measure of measures) last.set(measure.key, Math.round(measure.value));
  return [...last].map(([key, value]) => {
    const known = BUDGETS[key];
    const budget = known?.budget ?? Number.POSITIVE_INFINITY;
    return {
      key,
      label: known?.label ?? key,
      unit: known?.unit ?? "",
      value,
      budget,
      over: value > budget,
    };
  });
}

/** The run's last line. Zero scenarios is a failure: nothing was checked. */
export function verdictLine(passed: boolean, scenarios: number): string {
  return `CANLI: ${passed && scenarios > 0 ? "PASS" : "FAIL"} (${scenarios} senaryo)`;
}

/** Links that point at placeholders instead of the real site: the template's domain or repo owner. */
export function deadLinks(hrefs: string[]): string[] {
  return [...new Set(hrefs)].filter((href) => /dozo\.example|\/OWNER\//i.test(href));
}

/** Whether a fingerprinted asset is cached for good: public, a year or more, immutable. */
export function cachedForGood(cacheControl: string | undefined | null): boolean {
  if (!cacheControl) return false;
  const parts = cacheControl
    .toLowerCase()
    .split(",")
    .map((part) => part.trim());
  const maxAge = Number(parts.find((part) => part.startsWith("max-age="))?.slice(8));
  return parts.includes("public") && parts.includes("immutable") && maxAge >= 31_536_000;
}
