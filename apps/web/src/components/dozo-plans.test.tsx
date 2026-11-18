// @vitest-environment jsdom

import type { BillingStatus } from "@rakazo/contracts";
import { BYOK_TIERS, sandboxAllowanceHours } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: Billing offers the paid plans once the brand rules are applied.

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Button = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  );
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const containers = [
    "Card CardContent CardFooter CardHeader AlertDialog AlertDialogContent AlertDialogDescription",
    "AlertDialogFooter AlertDialogHeader AlertDialogTitle Dialog DialogContent DialogDescription",
    "DialogHeader DialogTitle Select SelectContent SelectGroup SelectItem SelectTrigger SelectValue",
    "ToggleGroup",
  ].flatMap((names) => names.split(" "));
  return {
    Button,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    ToggleGroupItem: Button,
    ...Object.fromEntries(containers.map((name) => [name, Container])),
  };
});

import type { RpcClient } from "../lib/rpc";
import { ModelCreditsSettings } from "./ModelCredits";

const offers = (["pro", "max"] as const).map((tier) => ({
  tier,
  name: BYOK_TIERS[tier].name,
  monthlyPriceCents: BYOK_TIERS[tier].monthlyPriceCents ?? 0,
  annualPriceCents: BYOK_TIERS[tier].annualPriceCents,
  computerSize: BYOK_TIERS[tier].computerSize,
  computerHours: sandboxAllowanceHours(BYOK_TIERS[tier].computerAllowanceCents),
}));

/** What the server answers for an organization on Free. */
const free: BillingStatus = {
  funding: "byok",
  access: true,
  state: "none",
  canManage: true,
  creditPurchasesEnabled: false,
  byokPriceCents: null,
  byokAnnualPriceCents: null,
  byokTier: "standard",
  byokTiers: offers,
  byokFreeUntil: null,
  balanceUsd: 0,
  monthlyAmountCents: null,
  computerHoursLeft: 0,
  trialAvailable: false,
  trialDays: 7,
  price: null,
  seats: 1,
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  cancelAtPeriodEnd: false,
  hasCustomer: false,
};

const checkout = vi.fn(async (_terms: unknown) => ({ url: "#checkout" }));
const client = { billing: { checkout } } as unknown as RpcClient;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(status: BillingStatus) {
  await act(async () => {
    root.render(<ModelCreditsSettings status={status} refresh={async () => {}} client={client} />);
  });
}

function button(label: RegExp) {
  return [...container.querySelectorAll("button")].find((node) =>
    label.test(node.textContent ?? ""),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  checkout.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("offers Premium first to an organization on Free, at the server's price", async () => {
  await render(free);
  const dollars = (BYOK_TIERS.pro.monthlyPriceCents ?? 0) / 100;
  const subscribe = button(/^Subscribe for /);
  expect(subscribe?.textContent).toBe(`Subscribe for $${dollars} / month`);
  expect(container.textContent).toContain("Premium Plus");
  await act(async () => subscribe?.click());
  expect(checkout).toHaveBeenCalledWith({ interval: "month", tier: "pro" });
});

it("announces no end date for Free", async () => {
  await render(free);
  expect(container.textContent).toContain("Using your API key");
  expect(container.textContent).not.toContain("Free plan ends");
});

it("keeps announcing the end of a free period", async () => {
  await render({
    ...free,
    byokPriceCents: offers[0]!.monthlyPriceCents,
    byokFreeUntil: "2030-01-15T00:00:00.000Z",
  });
  expect(container.textContent).toContain("Free plan ends Jan 15, 2030");
  expect(button(/^Subscribe for /)).toBeDefined();
});

it("offers a subscriber no second subscription", async () => {
  await render({
    ...free,
    state: "active",
    byokTier: "pro",
    byokPriceCents: offers[0]!.monthlyPriceCents,
    hasCustomer: true,
  });
  expect(button(/^Subscribe for /)).toBeUndefined();
  expect(container.querySelector('[data-testid="own-key-plan"]')?.textContent).toContain(
    `$${offers[0]!.monthlyPriceCents / 100} / month`,
  );
});

it("offers nothing to buy to a member who cannot manage billing", async () => {
  await render({ ...free, canManage: false });
  expect(button(/^Subscribe for /)).toBeUndefined();
});
