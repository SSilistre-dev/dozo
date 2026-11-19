// @vitest-environment jsdom
import type { PlanEnd } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: `PlanEnd` comes from the contracts once the brand rules apply.

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  }),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Text: ({
    children,
    style,
    testID,
  }: {
    children?: ReactNode;
    style?: unknown;
    testID?: string;
  }) => (
    <span
      data-testid={testID}
      data-color={([style].flat() as { color?: string }[]).find((x) => x.color)?.color}
    >
      {children}
    </span>
  ),
}));
vi.mock("./i18n", () => ({ dateLocaleForUi: () => "en-US" }));
vi.mock("./native", () => ({
  native: { secondaryLabel: "secondary" },
  useMobileTokens: () => ({ warning: "warning" }),
}));
vi.mock("../components/settings-group", () => ({
  SettingsRow: ({ title, trailing }: { title: string; trailing?: ReactNode }) => (
    <div>
      <b>{title}</b>
      {trailing}
    </div>
  ),
}));

import { DozoPlanEndRow } from "../components/dozo-plan-end-row";

/** Local noon `days` calendar days after the fixed today, Nov 19, 2026. */
const at = (days: number) => new Date(2026, 10, 19 + days, 12).toISOString();

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function row(end: PlanEnd) {
  await act(async () => root.render(<DozoPlanEndRow end={end} />));
  const [day, left] = [...container.querySelectorAll<HTMLElement>('[data-testid="plan-end"] span')];
  return {
    title: container.querySelector("b")?.textContent,
    value: [day?.textContent, left?.textContent],
    color: day?.dataset.color,
  };
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

it("says when a plan renews and the days left, in the usual colour", async () => {
  expect(await row({ at: at(14), renews: true })).toEqual({
    title: "Renews",
    value: ["Dec 3, 2026", "14 days left"],
    color: "secondary",
  });
});

it("says when a plan ends, in the warning colour from seven days before", async () => {
  expect(await row({ at: at(8), renews: false })).toMatchObject({
    title: "Ends",
    color: "secondary",
  });
  expect(await row({ at: at(7), renews: false })).toEqual({
    title: "Ends",
    value: ["Nov 26, 2026", "7 days left"],
    color: "warning",
  });
});

it("names tomorrow and today instead of a count", async () => {
  expect((await row({ at: at(1), renews: false })).value).toEqual(["Nov 20, 2026", "Tomorrow"]);
  expect((await row({ at: at(0), renews: false })).value).toEqual(["Nov 19, 2026", "Today"]);
});

it("names the plan that follows a granted plan above a subscription, without a warning", async () => {
  expect(
    await row({ at: at(3), renews: false, fallsTo: { from: "Premium Plus", to: "Premium" } }),
  ).toEqual({
    title: "Ends",
    value: ["Nov 22, 2026", "Premium Plus → Premium"],
    color: "secondary",
  });
});
