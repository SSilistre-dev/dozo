// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), upstream: vi.fn() }));

vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: mocks.capabilities }));
vi.mock("./Auth", () => ({
  AuthPage: (props: { mode: string }) => {
    mocks.upstream(props);
    return <div data-testid="upstream">{props.mode}</div>;
  },
}));

import { AuthPage } from "./dozo-auth";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.capabilities.mockReset();
  mocks.upstream.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Where() {
  const { pathname, search } = useLocation();
  return <output>{pathname + search}</output>;
}

async function open(path: string) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/sign-in" element={<AuthPage mode="in" />} />
          <Route path="/sign-up" element={<AuthPage mode="up" />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

const shown = () => container.querySelector('[data-testid="upstream"]')?.textContent;
const signups = () =>
  container.querySelector("[data-dozo-signups]")?.getAttribute("data-dozo-signups");
const where = () => container.querySelector("output")?.textContent;

it("is upstream's page, props unchanged, while registration is open", async () => {
  mocks.capabilities.mockResolvedValue({ signupsOpen: true });
  await open("/sign-up?next=%2Fapp");
  expect(shown()).toBe("up");
  expect(signups()).toBe("open");
  expect(where()).toBe("/sign-up?next=%2Fapp");
  expect(mocks.upstream).toHaveBeenLastCalledWith({ mode: "up" });
});

it("counts a server that does not say as open", async () => {
  mocks.capabilities.mockResolvedValue({});
  await open("/sign-up");
  expect(shown()).toBe("up");
  expect(signups()).toBe("open");
});

it("shows sign-in at the sign-up address while registration is closed, keeping the destination", async () => {
  mocks.capabilities.mockResolvedValue({ signupsOpen: false });
  await open("/sign-up?next=%2Fapp");
  expect(where()).toBe("/sign-in?next=%2Fapp");
  expect(shown()).toBe("in");
  expect(signups()).toBe("closed");
});

it("marks sign-in so the stylesheet can hide the way to sign-up", async () => {
  mocks.capabilities.mockResolvedValue({ signupsOpen: false });
  await open("/sign-in");
  expect(where()).toBe("/sign-in");
  expect(shown()).toBe("in");
  expect(signups()).toBe("closed");
});

it("holds sign-up back until the server answers, and shows sign-in meanwhile with the link hidden", async () => {
  const answer = deferred<{ signupsOpen?: boolean }>();
  mocks.capabilities.mockReturnValue(answer.promise);
  await open("/sign-up");
  expect(shown()).toBeUndefined();
  expect(where()).toBe("/sign-up");
  await act(async () => answer.resolve({ signupsOpen: true }));
  expect(shown()).toBe("up");

  act(() => root?.unmount());
  container.remove();
  mocks.capabilities.mockReturnValue(deferred().promise);
  await open("/sign-in");
  expect(shown()).toBe("in");
  expect(signups()).toBe("pending");
});

it("leaves a failed capabilities request to upstream's page", async () => {
  mocks.capabilities.mockRejectedValue(new Error("offline"));
  await open("/sign-up");
  expect(shown()).toBe("up");
  expect(signups()).toBe("open");
});

it.each([
  [
    "answer",
    (held: ReturnType<typeof deferred<{ signupsOpen: boolean }>>) =>
      held.resolve({ signupsOpen: false }),
  ],
  [
    "failure",
    (held: ReturnType<typeof deferred<{ signupsOpen: boolean }>>) =>
      held.reject(new Error("offline")),
  ],
])("drops an %s that arrives after the page is gone", async (_, settle) => {
  const held = deferred<{ signupsOpen: boolean }>();
  mocks.capabilities.mockReturnValue(held.promise);
  await open("/sign-in");
  act(() => root?.unmount());
  await act(async () => settle(held));
  expect(container.querySelector("[data-dozo-signups]")).toBeNull();
  expect(mocks.upstream).toHaveBeenCalledTimes(1);
});
