// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: the plan names exist once the brand rules are applied.

const api = vi.hoisted(() => ({ setPlan: vi.fn(), toastError: vi.fn() }));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoAdmin: { setPlan: api.setPlan } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoAdmin: { users: { key: () => ["users"] }, user: { key: () => ["user"] } },
  }),
}));
vi.mock("../lib/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("../components/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    title: ReactNode;
    children: ReactNode;
    confirmLabel: ReactNode;
    confirmDisabled?: boolean;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
  }) => (
    <div role="alertdialog">
      <h2>{props.title}</h2>
      {props.children}
      <button type="button" disabled={props.busy} onClick={props.onCancel}>
        Cancel
      </button>
      <button
        type="button"
        data-confirm
        disabled={props.busy || props.confirmDisabled}
        onClick={props.onConfirm}
      >
        {props.confirmLabel}
      </button>
    </div>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  toast: { error: api.toastError },
}));

import type { DozoAdminPlan } from "@rakazo/contracts";
import type * as Query from "../lib/query";
import { DozoPlanAction, DozoPlanSummary } from "./dozo-admin-plan";

type Plan = { tier: "standard" | "pro" | "max"; grantedUntil: string | null };
type Ends = NonNullable<DozoAdminPlan["ends"]>;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function render(plan: Plan) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DozoPlanAction
          user={{ id: "ada", email: "ada@example.test", plan: { ends: null, ...plan } }}
        />
      </QueryClientProvider>,
    );
  });
}

const shown = () => container.querySelector('[data-testid="admin-plan"]')?.textContent;

function button(name: string) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

const click = (node: HTMLElement) => act(async () => node.click());
const select = () => container.querySelector("select") as HTMLSelectElement;
const date = () => container.querySelector('input[type="date"]') as HTMLInputElement | null;

/** Types into a controlled field the way a person does. */
async function enter(node: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set?.call(node, value);
    node.dispatchEvent(
      new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.setPlan.mockReset();
  api.toastError.mockReset();
  api.setPlan.mockResolvedValue({ plan: { tier: "pro", grantedUntil: null } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows the plan's name, what keeps it and the days it has left, with the day on hover", async () => {
  await render({ tier: "standard", grantedUntil: null });
  expect(shown()).toBe("Free");
  await render({ tier: "pro", grantedUntil: null });
  expect(shown()).toBe("Premium");
  const summary = async (tier: Plan["tier"], ends: Ends) => {
    await act(async () => {
      root.render(<DozoPlanSummary plan={{ tier, grantedUntil: null, ends }} />);
    });
    return shown();
  };
  // Days are counted from today, as the member's own page counts them.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-12-24T12:00:00.000Z"));
    const at = "2027-01-05T12:00:00.000Z";
    const end = { at, renews: false };
    expect(await summary("max", { ...end, source: "granted" })).toBe(
      "Premium PlusGranted12 days left",
    );
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe("Jan 5, 2027");
    expect(
      await summary("max", {
        ...end,
        source: "granted",
        fallsTo: { from: "Premium Plus", to: "Premium" },
      }),
    ).toBe("Premium PlusGranted12 days leftThen Premium");
    expect(
      await summary("pro", { at: "2026-12-25T12:00:00.000Z", source: "trial", renews: false }),
    ).toBe("PremiumTrial1 day left");
    expect(await summary("pro", { at, source: "subscription", renews: true })).toBe(
      "PremiumSubscriptionRenews in 12 days",
    );
    expect(
      await summary("pro", {
        at: "2026-12-25T12:00:00.000Z",
        source: "subscription",
        renews: true,
      }),
    ).toBe("PremiumSubscriptionRenews in 1 day");
    expect(await summary("standard", { ...end, source: "freeMonth" })).toBe(
      "FreeFree period12 days left",
    );
  } finally {
    vi.useRealTimers();
  }
});

it("gives a plan until the chosen day, and reads the list again", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await render({ tier: "standard", grantedUntil: null });
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  await click(button("Set plan"));
  expect(container.querySelector("h2")?.textContent).toBe("Plan for ada@example.test");
  expect([...select().options].map((option) => option.textContent)).toEqual([
    "Premium",
    "Premium Plus",
  ]);
  // A plan needs an end date.
  expect(button("Save").disabled).toBe(true);
  await enter(select(), "max");
  await enter(date() as HTMLInputElement, "2027-02-01");
  expect(button("Save").disabled).toBe(false);
  await click(button("Save"));
  expect(api.setPlan).toHaveBeenCalledWith({
    userId: "ada",
    tier: "max",
    endsAt: "2027-02-01T12:00:00.000Z",
  });
  await vi.waitFor(() => expect(container.querySelector('[role="alertdialog"]')).toBeNull());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["users"] });
});

it("makes tomorrow, on the admin's calendar, the first day that can be chosen", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // Late on the 31st: the day after is in the next month.
    vi.setSystemTime(new Date("2026-12-31T23:30:00.000Z"));
    await render({ tier: "standard", grantedUntil: null });
    await click(button("Set plan"));
    expect(date()?.min).toBe("2027-01-01");
  } finally {
    vi.useRealTimers();
  }
});

it("starts from the granted plan, and takes it back without a date", async () => {
  await render({ tier: "max", grantedUntil: "2027-01-05T23:59:59.000Z" });
  await click(button("Set plan"));
  expect(select().value).toBe("max");
  expect(date()?.value).toBe("2027-01-05");
  expect([...select().options].map((option) => option.textContent)).toContain(
    "Remove granted plan",
  );
  await enter(select(), "none");
  expect(date()).toBeNull();
  expect(button("Save").disabled).toBe(false);
  await click(button("Save"));
  expect(api.setPlan).toHaveBeenCalledWith({ userId: "ada", tier: null });
  await vi.waitFor(() => expect(container.querySelector('[role="alertdialog"]')).toBeNull());
});

it("offers Premium first when the plan in force is a subscription's", async () => {
  await render({ tier: "pro", grantedUntil: null });
  await click(button("Set plan"));
  expect(select().value).toBe("pro");
  expect(date()?.value).toBe("");
  await render({ tier: "pro", grantedUntil: "2027-01-05T23:59:59.000Z" });
  expect(select().value).toBe("pro");
});

it("says so and keeps the form when the change fails", async () => {
  api.setPlan.mockRejectedValue(new Error("The end date must be in the future"));
  await render({ tier: "standard", grantedUntil: null });
  await click(button("Set plan"));
  await enter(date() as HTMLInputElement, "2020-01-01");
  await click(button("Save"));
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("The end date must be in the future"),
  );
  expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(date()?.value).toBe("2020-01-01");
});

it("changes nothing when cancelled", async () => {
  await render({ tier: "standard", grantedUntil: null });
  await click(button("Set plan"));
  await click(button("Cancel"));
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(api.setPlan).not.toHaveBeenCalled();
});
