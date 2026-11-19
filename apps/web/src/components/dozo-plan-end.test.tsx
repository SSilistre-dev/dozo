// @vitest-environment jsdom

import type { BillingStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: the status carries `planEnd` once the brand rules are applied.

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

import { DozoPlanEnd } from "./dozo-plan-end";

const status = {
  access: true,
  canManage: true,
  trialAvailable: false,
  trialDays: 0,
  state: "none",
  price: null,
  seats: 1,
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  cancelAtPeriodEnd: false,
  hasCustomer: false,
} satisfies BillingStatus;

/** Local noon `days` calendar days after the fixed today, Nov 19, 2026. */
const at = (days: number) => new Date(2026, 10, 19 + days, 12).toISOString();

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** The date part and the days-left part, each its own element. */
const parts = (el: HTMLElement | null) =>
  [...(el?.querySelectorAll("span") ?? [])].map((span) => span.textContent);

async function line(planEnd?: BillingStatus["planEnd"]) {
  await act(async () => root.render(<DozoPlanEnd status={{ ...status, planEnd }} />));
  return container.querySelector<HTMLElement>('[data-testid="plan-end"]');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 9));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("shows nothing for a plan without an end", async () => {
  expect(await line()).toBeNull();
});

it("says when a plan renews and how many days are left, without a warning", async () => {
  const shown = await line({ at: at(14), renews: true });
  expect(parts(shown)).toEqual(["Renews Dec 3, 2026", "14 days left"]);
  expect(shown?.className).toContain("text-muted-foreground");
  expect((await line({ at: at(2), renews: true }))?.className).not.toContain("text-warning");
});

it("says when a plan ends, and warns from seven days before", async () => {
  const far = await line({ at: at(8), renews: false });
  expect(parts(far)).toEqual(["Ends Nov 27, 2026", "8 days left"]);
  expect(far?.className).not.toContain("text-warning");
  const near = await line({ at: at(7), renews: false });
  expect(parts(near)).toEqual(["Ends Nov 26, 2026", "7 days left"]);
  expect(near?.className).toContain("text-warning");
});

it("names tomorrow and today instead of a count", async () => {
  expect(parts(await line({ at: at(1), renews: false }))).toEqual([
    "Ends Nov 20, 2026",
    "Tomorrow",
  ]);
  expect(parts(await line({ at: at(0), renews: false }))).toEqual(["Ends Nov 19, 2026", "Today"]);
});

it("names the plan that follows a granted plan above a subscription, without a warning", async () => {
  const shown = await line({
    at: at(3),
    renews: false,
    fallsTo: { from: "Premium Plus", to: "Premium" },
  });
  expect(parts(shown)).toEqual(["Ends Nov 22, 2026", "Premium Plus → Premium"]);
  expect(shown?.className).not.toContain("text-warning");
});
