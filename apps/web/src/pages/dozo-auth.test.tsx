// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  upstream: vi.fn(),
  setUiLocale: vi.fn(),
  active: "en",
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  OptionSelect: (props: {
    value: string;
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
    "aria-label": string;
  }) => (
    <select
      aria-label={props["aria-label"]}
      value={props.value}
      onChange={(event) => props.onValueChange(event.target.value)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../lib/i18n", () => ({
  getActiveUiLocale: () => mocks.active,
  setUiLocale: mocks.setUiLocale,
}));

vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: mocks.capabilities }));
vi.mock("./Auth", () => ({
  AuthPage: (props: { mode: string }) => {
    mocks.upstream(props);
    return <div data-testid="upstream">{props.mode}</div>;
  },
}));

import { takeSignupStarted } from "../lib/dozo-signup-start";
import { AuthPage } from "./dozo-auth";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.capabilities.mockReset();
  mocks.upstream.mockClear();
  mocks.active = "en";
  mocks.setUiLocale.mockReset();
  mocks.setUiLocale.mockImplementation(async (locale: string) => {
    mocks.active = locale;
    return locale;
  });
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
          <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
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

it("keeps when the sign-up form opened, only while registration is open", async () => {
  window.sessionStorage.clear();
  mocks.capabilities.mockResolvedValue({ signupsOpen: false });
  await open("/sign-up");
  expect(takeSignupStarted()).toBeNull();
  mocks.capabilities.mockResolvedValue({ signupsOpen: true });
  await open("/sign-in");
  expect(takeSignupStarted()).toBeNull();
  await open("/sign-up");
  expect(takeSignupStarted()).toEqual(expect.any(String));
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

const language = () => container.querySelector<HTMLSelectElement>('select[aria-label="Language"]');

it("shows the language a link asked for from the first paint, saves it and drops the parameter", async () => {
  mocks.capabilities.mockResolvedValue({ signupsOpen: true });
  const loading = deferred<string>();
  mocks.setUiLocale.mockReturnValue(loading.promise);
  await open("/sign-up?lang=tr&next=%2Fapp");
  expect(mocks.setUiLocale).toHaveBeenCalledExactlyOnceWith("tr");
  expect(shown()).toBeUndefined();
  await act(async () => loading.resolve("tr"));
  expect(shown()).toBe("up");
  expect(language()?.value).toBe("tr");
  expect(where()).toBe("/sign-up?next=%2Fapp");
});

it("keeps the asked language when registration is closed and the address changes", async () => {
  mocks.capabilities.mockResolvedValue({ signupsOpen: false });
  await open("/sign-up?lang=tr");
  expect(mocks.setUiLocale).toHaveBeenCalledWith("tr");
  expect(where()).toBe("/sign-in");
  expect(language()?.value).toBe("tr");
});

it.each([
  "TR",
  "tr-TR",
  "xx",
  "",
  "//evil.example",
  "https://evil.example",
  "<script>alert(1)</script>",
  "__proto__",
])("ignores %j as a language and only drops it from the address", async (value) => {
  mocks.capabilities.mockResolvedValue({ signupsOpen: true });
  await open(`/sign-in?lang=${encodeURIComponent(value)}&next=%2Fapp`);
  expect(mocks.setUiLocale).not.toHaveBeenCalled();
  expect(shown()).toBe("in");
  expect(language()?.value).toBe("en");
  expect(where()).toBe("/sign-in?next=%2Fapp");
  expect(container.innerHTML).not.toContain("evil");
});

it("saves a language chosen on the page through the app's own preference", async () => {
  mocks.capabilities.mockResolvedValue({ signupsOpen: true });
  await open("/sign-in");
  const select = language();
  if (!select) throw new Error("no language choice");
  await act(async () => {
    select.value = "tr";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(mocks.setUiLocale).toHaveBeenCalledExactlyOnceWith("tr");
  expect(language()?.value).toBe("tr");
});

const intent = () => window.sessionStorage.getItem("dozo:plan-intent");

it.each([
  ["premium", "year", { tier: "pro", period: "year" }],
  ["premium_plus", "month", { tier: "max", period: "month" }],
])(
  "keeps plan %j billed every %j for the tab and drops both from the address",
  async (plan, period, kept) => {
    window.sessionStorage.clear();
    mocks.capabilities.mockResolvedValue({ signupsOpen: true });
    await open(`/sign-up?plan=${plan}&period=${period}&next=%2Fapp`);
    expect(where()).toBe("/sign-up?next=%2Fapp");
    expect(shown()).toBe("up");
    expect(JSON.parse(intent() ?? "null")).toMatchObject(kept);
  },
);

it.each([
  "plan=free&period=year",
  "plan=pro&period=year",
  "plan=%3Cscript%3E&period=month",
  "period=year",
  "plan=",
])("keeps nothing for %j and only drops it from the address", async (query) => {
  window.sessionStorage.clear();
  mocks.capabilities.mockResolvedValue({ signupsOpen: true });
  await open(`/sign-up?${query}&next=%2Fapp`);
  expect(where()).toBe("/sign-up?next=%2Fapp");
  expect(intent()).toBeNull();
});

it("keeps the plan and the language together, dropping all three parameters once", async () => {
  window.sessionStorage.clear();
  mocks.capabilities.mockResolvedValue({ signupsOpen: true });
  await open("/sign-up?lang=tr&plan=premium&period=year");
  expect(mocks.setUiLocale).toHaveBeenCalledWith("tr");
  expect(where()).toBe("/sign-up");
  expect(language()?.value).toBe("tr");
  expect(JSON.parse(intent() ?? "null")).toMatchObject({ tier: "pro", period: "year" });
});

it("drops a filled-in address once upstream's page is up, keeping the destination", async () => {
  mocks.capabilities.mockResolvedValue({ signupsOpen: true });
  await open("/sign-in?email=ada%40example.com&next=%2Fapp");
  expect(where()).toBe("/sign-in?next=%2Fapp");
  expect(shown()).toBe("in");
});

it("keeps the plan when registration is closed and sign-in shows instead", async () => {
  window.sessionStorage.clear();
  mocks.capabilities.mockResolvedValue({ signupsOpen: false });
  await open("/sign-up?plan=premium_plus&period=year");
  expect(where()).toBe("/sign-in");
  expect(JSON.parse(intent() ?? "null")).toMatchObject({ tier: "max", period: "year" });
});

it("names sign-up and sign-in in the tab's title, and gives the title back on leaving", async () => {
  document.title = "Dozo";
  mocks.capabilities.mockResolvedValue({ signupsOpen: true });
  await open("/sign-up");
  expect(document.title).toBe("Sign up – Dozo");
  act(() => root?.unmount());
  expect(document.title).toBe("Dozo");
  container.remove();
  await open("/sign-in");
  expect(document.title).toBe("Sign in – Dozo");
  act(() => root?.unmount());
  container.remove();
  await open("/forgot-password");
  expect(document.title).toBe("Dozo");
});
