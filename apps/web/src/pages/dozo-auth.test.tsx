// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { FormEvent, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  upstream: vi.fn(),
  setUiLocale: vi.fn(),
  active: "en",
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
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
vi.mock("@rakazo/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/contracts")>()),
  signInProviders: (capabilities: { providers?: { id: string }[] }) => capabilities.providers ?? [],
}));
vi.mock("./dozo-code-sign-in", () => ({
  DozoCodeSignIn: ({ providers }: { providers: { id: string }[] }) => (
    <div data-testid="code-first">{providers.map((provider) => provider.id).join(",")}</div>
  ),
}));
vi.mock("./dozo-hosted-login", () => ({
  HostedSignIn: () => <div data-testid="hosted">hosted</div>,
}));
vi.mock("./Auth", () => ({
  submitClass: "submit",
  AuthFrame: ({
    title,
    onSubmit,
    children,
  }: {
    title: ReactNode;
    onSubmit: (event: FormEvent) => void;
    children: ReactNode;
  }) => (
    <form onSubmit={onSubmit}>
      <h1>{title}</h1>
      {children}
    </form>
  ),
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
          <Route path="/sign-in/email" element={<AuthPage mode="in" />} />
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
  window.localStorage.clear();
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
  // Sign-in waits too (the email-first form or upstream's depends on the answer); the password
  // form at its own address shows meanwhile, with the link to sign-up hidden.
  mocks.capabilities.mockReturnValue(deferred().promise);
  await open("/sign-in");
  expect(shown()).toBeUndefined();
  expect(container.querySelector('[data-testid="code-first"]')).toBeNull();
  act(() => root?.unmount());
  container.remove();
  await open("/sign-in/email");
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
  await open("/sign-in/email");
  act(() => root?.unmount());
  await act(async () => settle(held));
  expect(container.querySelector("[data-dozo-signups]")).toBeNull();
  expect(mocks.upstream).toHaveBeenCalledTimes(1);
});

describe("email-first sign-in", () => {
  const codeFirst = () => container.querySelector('[data-testid="code-first"]')?.textContent;

  it("starts sign-in with the address and a code where the server mails codes", async () => {
    mocks.capabilities.mockResolvedValue({
      signupsOpen: true,
      passwordAuth: true,
      emailCode: true,
      providers: [{ id: "google" }],
    });
    await open("/sign-in?next=%2Fapp");
    expect(codeFirst()).toBe("google");
    expect(shown()).toBeUndefined();
    expect(signups()).toBe("open");
    expect(where()).toBe("/sign-in?next=%2Fapp");
  });

  it("keeps upstream's password form one step away, and sign-up unchanged", async () => {
    mocks.capabilities.mockResolvedValue({ passwordAuth: true, emailCode: true });
    await open("/sign-in/email");
    expect(shown()).toBe("in");
    expect(codeFirst()).toBeUndefined();
    act(() => root?.unmount());
    container.remove();
    await open("/sign-up");
    expect(shown()).toBe("up");
    expect(codeFirst()).toBeUndefined();
  });

  it.each([
    ["no mail sender", { passwordAuth: true, emailCode: false }],
    ["password sign-in off", { passwordAuth: false, emailCode: true }],
  ])("falls back to upstream's page with %s", async (_, capabilities) => {
    mocks.capabilities.mockResolvedValue(capabilities);
    await open("/sign-in");
    expect(shown()).toBe("in");
    expect(codeFirst()).toBeUndefined();
  });

  it("leaves a failed capabilities request at sign-in to upstream's page", async () => {
    mocks.capabilities.mockRejectedValue(new Error("offline"));
    await open("/sign-in");
    expect(shown()).toBe("in");
    expect(codeFirst()).toBeUndefined();
  });

  it("keeps closed registration's mark on the email-first form", async () => {
    mocks.capabilities.mockResolvedValue({
      signupsOpen: false,
      passwordAuth: true,
      emailCode: true,
    });
    await open("/sign-up");
    expect(where()).toBe("/sign-in");
    expect(codeFirst()).toBe("");
    expect(signups()).toBe("closed");
  });
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

it("offers only the hosted account on a server that signs in with it, at the sign-in address", async () => {
  mocks.capabilities.mockResolvedValue({ signupsOpen: true, hostedLogin: true });
  await open("/sign-in?error=hosted_login_failed");
  expect(container.querySelector('[data-testid="hosted"]')).not.toBeNull();
  expect(shown()).toBeUndefined();
  expect(language()).not.toBeNull();
  for (const path of ["/sign-up?next=%2Fapp", "/forgot-password"]) {
    act(() => root?.unmount());
    container.remove();
    await open(path);
    expect(where()).toBe(path.startsWith("/sign-up") ? "/sign-in?next=%2Fapp" : "/sign-in");
    expect(container.querySelector('[data-testid="hosted"]')).not.toBeNull();
  }
});

describe("on a server on the person's own computer", () => {
  beforeEach(() => {
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      hostname: "127.0.0.1",
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows nothing until the server answers, never a password form first", async () => {
    const answer = deferred<{ hostedLogin?: boolean }>();
    mocks.capabilities.mockReturnValue(answer.promise);
    await open("/sign-in");
    expect(shown()).toBeUndefined();
    expect(container.querySelector("form")).toBeNull();
    await act(async () => answer.resolve({ hostedLogin: true }));
    expect(container.querySelector('[data-testid="hosted"]')).not.toBeNull();
  });

  it("says the server could not be reached and asks again, without a password form", async () => {
    mocks.capabilities.mockRejectedValueOnce(new Error("offline"));
    mocks.capabilities.mockResolvedValueOnce({ hostedLogin: true });
    await open("/sign-in");
    expect(container.querySelector("h1")?.textContent).toBe("Could not reach the server");
    expect(shown()).toBeUndefined();
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="hosted"]')).not.toBeNull(),
    );
    expect(mocks.capabilities).toHaveBeenCalledTimes(2);
  });
});
