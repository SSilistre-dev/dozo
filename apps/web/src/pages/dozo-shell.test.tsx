// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userId: "user-a" as string | undefined,
  me: vi.fn(),
  status: vi.fn(),
}));
vi.mock("./Shell", () => ({ ShellPage: () => <div data-testid="upstream-shell" /> }));
vi.mock("../lib/auth", () => ({
  authClient: {
    useSession: () => ({ data: mocks.userId ? { user: { id: mocks.userId } } : null }),
  },
}));
vi.mock("../lib/rpc", () => ({ rpc: { me: mocks.me, billing: { status: mocks.status } } }));

import { readPlanIntent, savePlanIntent } from "../lib/dozo-plan-intent";
import { NavigateKeepingPlan, ShellPage } from "./dozo-shell";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let go: (to: string) => void;

/** Billing as the server answers for an owner on Free. */
const free = {
  canManage: true,
  funding: "byok",
  byokPriceCents: null,
  byokTier: "standard",
};

function Where() {
  const { pathname, search } = useLocation();
  go = useNavigate();
  return <output>{pathname + search}</output>;
}

async function open(path: string) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/app" element={<ShellPage />} />
          <Route path="/app/:botId" element={<ShellPage />} />
          <Route path="/onboarding" element={<p>onboarding</p>} />
          <Route path="/sign-up" element={<NavigateKeepingPlan to="/onboarding" />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
async function reopen(path: string) {
  act(() => root.unmount());
  root = createRoot(container);
  await open(path);
}
const where = () => container.querySelector("output")?.textContent;
const navigate = (to: string) => act(async () => go(to));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.userId = "user-a";
  mocks.me.mockReset().mockResolvedValue({ billingEnabled: true });
  mocks.status.mockReset().mockResolvedValue(free);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

it("is upstream's shell and asks nothing without a picked plan", async () => {
  await open("/app/bot-1");
  expect(container.querySelector('[data-testid="upstream-shell"]')).not.toBeNull();
  expect(where()).toBe("/app/bot-1");
  expect(mocks.me).not.toHaveBeenCalled();
});

it("offers the picked plan in Billing once setup opens the app, and forgets it when closed", async () => {
  savePlanIntent({ tier: "pro", period: "year" });
  await open("/app/bot-1");
  expect(where()).toBe("/app/bot-1?settings=billing");
  expect(readPlanIntent("user-a")).toEqual({ tier: "pro", period: "year" });

  await navigate("/app/bot-1");
  expect(where()).toBe("/app/bot-1");
  expect(readPlanIntent()).toBeNull();

  await reopen("/app/bot-1");
  expect(where()).toBe("/app/bot-1");
});

it("counts moving to another section as the answer, and keeps the app's other parameters", async () => {
  savePlanIntent({ tier: "max", period: "month" });
  await open("/app/bot-1?thread=t1");
  expect(where()).toBe("/app/bot-1?thread=t1&settings=billing");
  await navigate("/app/bot-1?thread=t1&settings=general");
  expect(readPlanIntent()).toBeNull();
  await navigate("/app/bot-1?thread=t1&settings=billing");
  await navigate("/app/bot-1?thread=t1");
  expect(where()).toBe("/app/bot-1?thread=t1");
});

it("waits for the session before claiming the pick", async () => {
  mocks.userId = undefined;
  savePlanIntent({ tier: "pro", period: "month" });
  await open("/app");
  expect(where()).toBe("/app");
  expect(mocks.me).not.toHaveBeenCalled();
  mocks.userId = "user-a";
  await reopen("/app");
  expect(where()).toBe("/app?settings=billing");
});

it.each([
  ["a paid plan", { ...free, byokPriceCents: 4900, byokTier: "pro" }],
  ["a plan an admin granted", { ...free, byokTier: "max" }],
  ["a member who cannot manage billing", { ...free, canManage: false }],
  ["monthly credits", { ...free, funding: "credits" }],
])("drops the pick quietly for %s", async (_, status) => {
  mocks.status.mockResolvedValue(status);
  savePlanIntent({ tier: "pro", period: "year" });
  await open("/app/bot-1");
  expect(where()).toBe("/app/bot-1");
  expect(readPlanIntent()).toBeNull();
});

it("drops the pick quietly on a server that does not bill, without asking for billing", async () => {
  mocks.me.mockResolvedValue({ billingEnabled: false });
  savePlanIntent({ tier: "pro", period: "year" });
  await open("/app/bot-1");
  expect(where()).toBe("/app/bot-1");
  expect(mocks.status).not.toHaveBeenCalled();
  expect(readPlanIntent()).toBeNull();
});

it("opens nothing and keeps the pick when the server cannot say", async () => {
  mocks.status.mockRejectedValue(new Error("offline"));
  savePlanIntent({ tier: "pro", period: "year" });
  await open("/app/bot-1");
  expect(where()).toBe("/app/bot-1");
  expect(readPlanIntent()).toEqual({ tier: "pro", period: "year" });
  mocks.status.mockResolvedValue(free);
  await reopen("/app/bot-1");
  expect(where()).toBe("/app/bot-1?settings=billing");
});

it("never offers one account's pick to the next account in the tab", async () => {
  savePlanIntent({ tier: "max", period: "year" });
  await open("/app/bot-1");
  expect(where()).toBe("/app/bot-1?settings=billing");
  // The first account leaves without answering; the next one signs in in the same tab.
  mocks.userId = "user-b";
  await reopen("/app/bot-2");
  expect(where()).toBe("/app/bot-2");
  expect(readPlanIntent()).toBeNull();
});

it("drops an answer that arrives after the shell is gone", async () => {
  let answer: (value: typeof free) => void = () => {};
  mocks.status.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  savePlanIntent({ tier: "pro", period: "month" });
  await open("/app");
  await navigate("/onboarding");
  await act(async () => answer(free));
  expect(where()).toBe("/onboarding");
  expect(readPlanIntent()).toEqual({ tier: "pro", period: "month" });
});

it("reopens Billing quietly after a checkout left unpaid, and drops the parameter", async () => {
  await open("/app?billing=canceled");
  expect(where()).toBe("/app?settings=billing");
  expect(container.textContent).not.toMatch(/cancel|error/i);
  await navigate("/app");
  expect(where()).toBe("/app");
});

it("keeps the pick through a checkout left unpaid, until Billing is closed", async () => {
  savePlanIntent({ tier: "max", period: "year" });
  await open("/app/bot-1?billing=canceled");
  expect(where()).toBe("/app/bot-1?settings=billing");
  expect(readPlanIntent()).toEqual({ tier: "max", period: "year" });
  await navigate("/app/bot-1");
  expect(readPlanIntent()).toBeNull();
});

it("leaves another billing parameter alone", async () => {
  await open("/app?billing=success");
  expect(where()).toBe("/app?billing=success");
});

it("keeps the plan a signed-in member's landing link names, then lands where it would", async () => {
  await open("/sign-up?lang=en&plan=premium_plus&period=year");
  expect(where()).toBe("/onboarding");
  expect(readPlanIntent()).toEqual({ tier: "max", period: "year" });
});

it("keeps nothing from a signed-in member's link without a paid plan", async () => {
  await open("/sign-up?plan=free&period=year");
  expect(where()).toBe("/onboarding");
  expect(readPlanIntent()).toBeNull();
});

it("forgets the pick of a paid account even when it comes back from a checkout left unpaid", async () => {
  mocks.status.mockResolvedValue({ ...free, byokPriceCents: 4900, byokTier: "pro" });
  savePlanIntent({ tier: "max", period: "year" });
  await open("/app/bot-1?billing=canceled");
  expect(where()).toBe("/app/bot-1?settings=billing");
  expect(readPlanIntent()).toBeNull();
});
