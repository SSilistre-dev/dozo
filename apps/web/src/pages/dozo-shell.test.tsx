// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./Shell", () => ({ ShellPage: () => <div data-testid="upstream-shell" /> }));

import { readPlanIntent, savePlanIntent } from "../lib/dozo-plan-intent";
import { ShellPage } from "./dozo-shell";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let go: (to: string) => void;

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
        </Routes>
      </MemoryRouter>,
    ),
  );
}
const where = () => container.querySelector("output")?.textContent;
const navigate = (to: string) => act(async () => go(to));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

it("is upstream's shell and opens nothing without a picked plan", async () => {
  await open("/app/bot-1");
  expect(container.querySelector('[data-testid="upstream-shell"]')).not.toBeNull();
  expect(where()).toBe("/app/bot-1");
});

it("offers the picked plan in Billing once setup opens the app, and forgets it when closed", async () => {
  savePlanIntent({ tier: "pro", period: "year" });
  await open("/app/bot-1");
  expect(where()).toBe("/app/bot-1?settings=billing");
  expect(readPlanIntent()).toEqual({ tier: "pro", period: "year" });

  await navigate("/app/bot-1");
  expect(where()).toBe("/app/bot-1");
  expect(readPlanIntent()).toBeNull();

  act(() => root.unmount());
  root = createRoot(container);
  await open("/app/bot-1");
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

it("keeps the pick when the shell hands over to setup instead", async () => {
  savePlanIntent({ tier: "pro", period: "month" });
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/app"]}>
        <Where />
        <Routes>
          <Route path="/app" element={<ShellPage />} />
          <Route path="/onboarding" element={<p>onboarding</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  // An app with no bot yet sends the person to setup; the offer waits for the app.
  await navigate("/onboarding");
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
