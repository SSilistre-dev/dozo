// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { FormEvent, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  session: { isPending: false, data: null as { user: { email: string } } | null },
  send: vi.fn(),
  capabilities: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  authClient: { useSession: () => api.session, sendVerificationEmail: api.send },
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: api.capabilities }));
vi.mock("../lib/user-error", () => ({
  authErrorText: (error: { code?: string }, fallback: string) =>
    error.code === "TOO_MANY_REQUESTS" ? "Too many attempts" : fallback,
}));
vi.mock("../lib/dozo-error-text", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  buttonVariants: () => "button",
  Input: (props: object) => <input {...props} />,
  Label: ({ children, htmlFor }: { children: ReactNode; htmlFor: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));
vi.mock("./Auth", () => ({
  submitClass: "submit",
  PasswordResetPage: () => <p>upstream reset form</p>,
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
}));

import { PasswordResetPage, VerifyEmailPage, verifyOutcome } from "./dozo-email-link";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let goTo: ((path: string) => void) | undefined;

function Where() {
  const { pathname, search } = useLocation();
  goTo = useNavigate();
  return <output>{pathname + search}</output>;
}

async function open(path: string | { pathname: string; state: unknown }) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/reset-password" element={<PasswordResetPage />} />
          <Route path="/" element={<p>home</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

const title = () => container.querySelector("h1")?.textContent;
const where = () => container.querySelector("output")?.textContent;
const links = () =>
  [...container.querySelectorAll("a")].map((a) => `${a.textContent} ${a.getAttribute("href")}`);
const button = () => container.querySelector("button");
const field = () => container.querySelector("input");

async function type(value: string) {
  const input = field();
  if (!input) throw new Error("no field");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.session = { isPending: false, data: null };
  api.send.mockReset();
  api.capabilities.mockReset();
  api.capabilities.mockResolvedValue({ emailCode: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("verifyOutcome", () => {
  it.each([
    [null, "verified"],
    [undefined, "verified"],
    ["", "verified"],
    ["TOKEN_EXPIRED", "expired"],
    ["INVALID_TOKEN", "invalid"],
    ["USER_NOT_FOUND", "invalid"],
    ["INVALID_USER", "invalid"],
    ["SOMETHING_NEW", "unknown"],
  ])("maps %j to %s", (code, outcome) => {
    expect(verifyOutcome(code)).toBe(outcome);
  });
});

describe("the verification result page", () => {
  it("confirms a verified address and sends a signed-out reader to sign-in with it filled in", async () => {
    await open("/verify-email?email=ada%2Bx%40example.com");
    expect(title()).toBe("Email verified");
    expect(links()).toEqual(["Continue /sign-in/email?email=ada%2Bx%40example.com"]);
    expect(where()).toBe("/verify-email");
  });

  it("sends a signed-in reader into the app", async () => {
    api.session = { isPending: false, data: { user: { email: "ada@example.com" } } };
    await open("/verify-email?email=ada%40example.com");
    expect(title()).toBe("Email verified");
    expect(links()).toEqual(["Continue /app"]);
  });

  it("keeps the screen on a reload, from the history entry", async () => {
    await open({
      pathname: "/verify-email",
      state: { error: "TOKEN_EXPIRED", email: "ada@example.com" },
    });
    expect(title()).toBe("This link has expired");
    await vi.waitFor(() => expect(field()?.value).toBe("ada@example.com"));
  });

  it("goes home when it has nothing to say", async () => {
    await open("/verify-email?email=ada%40example.com&error=USER_NOT_FOUND");
    expect(where()).toBe("/verify-email");
    await act(async () => goTo?.("/verify-email"));
    expect(where()).toBe("/");
  });

  it.each(["INVALID_TOKEN", "USER_NOT_FOUND", "INVALID_USER"])(
    "says %s is no longer valid, and offers sign-in",
    async (code) => {
      await open(`/verify-email?email=ada%40example.com&error=${code}`);
      expect(title()).toBe("This link is no longer valid");
      expect(links()).toEqual(["Sign in /sign-in/email?email=ada%40example.com"]);
      expect(where()).toBe("/verify-email");
    },
  );

  it("says an unknown code in general words", async () => {
    await open("/verify-email?error=SOMETHING_NEW");
    expect(title()).toBe("Could not open this link");
    expect(links()).toEqual(["Sign in /sign-in"]);
  });

  it("waits for the session before choosing the buttons", async () => {
    api.session = { isPending: true, data: null };
    await open("/verify-email?email=ada%40example.com");
    expect(title()).toBeUndefined();
  });
});

describe("an expired verification link", () => {
  it("asks a signed-out reader for the address, filled in, and sends a new link", async () => {
    api.send.mockResolvedValue({ data: { status: true }, error: null });
    await open("/verify-email?email=ada%40example.com&error=TOKEN_EXPIRED");
    expect(title()).toBe("This link has expired");
    await vi.waitFor(() => expect(button()?.textContent).toBe("Send a new link"));
    expect(field()?.value).toBe("ada@example.com");
    await type("  grace@example.com ");
    await submit();
    expect(api.send).toHaveBeenCalledWith({ email: "grace@example.com" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "We sent a new link to grace@example.com.",
    );
    expect(button()).toBeNull();
    expect(links()).toEqual(["Sign in /sign-in/email?email=ada%40example.com"]);
  });

  it("sends a signed-in reader's link in one tap, without a field", async () => {
    api.session = { isPending: false, data: { user: { email: "ada@example.com" } } };
    api.send.mockResolvedValue({ data: { status: true }, error: null });
    await open("/verify-email?error=TOKEN_EXPIRED");
    await vi.waitFor(() => expect(button()).not.toBeNull());
    expect(field()).toBeNull();
    await submit();
    expect(api.send).toHaveBeenCalledWith({ email: "ada@example.com" });
    expect(links()).toEqual(["Continue /app"]);
  });

  it("sends once while a request is in flight, and not with an empty address", async () => {
    const answer = deferred<{ data: null; error: { code: string } }>();
    api.send.mockReturnValue(answer.promise);
    await open("/verify-email?error=TOKEN_EXPIRED");
    await vi.waitFor(() => expect(button()).not.toBeNull());
    await submit();
    expect(api.send).not.toHaveBeenCalled();
    await type("ada@example.com");
    await submit();
    await submit();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(button()?.disabled).toBe(true);
    await act(async () => answer.resolve({ data: null, error: { code: "TOO_MANY_REQUESTS" } }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Too many attempts");
    expect(button()?.disabled).toBe(false);
  });

  it("says so when the request does not reach the server", async () => {
    api.send.mockRejectedValue(new TypeError("Failed to fetch"));
    await open("/verify-email?email=ada%40example.com&error=TOKEN_EXPIRED");
    await vi.waitFor(() => expect(button()).not.toBeNull());
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not send the link");
  });

  it("offers no new link from a server that sends no mail", async () => {
    api.capabilities.mockResolvedValue({ emailCode: false });
    await open("/verify-email?email=ada%40example.com&error=TOKEN_EXPIRED");
    await vi.waitFor(() => expect(api.capabilities).toHaveBeenCalled());
    expect(button()).toBeNull();
    expect(field()).toBeNull();
    expect(links()).toEqual(["Sign in /sign-in/email?email=ada%40example.com"]);
  });

  it("offers no new link when the server's capabilities cannot be read", async () => {
    api.capabilities.mockRejectedValue(new Error("offline"));
    await open("/verify-email?error=TOKEN_EXPIRED");
    await vi.waitFor(() => expect(api.capabilities).toHaveBeenCalled());
    expect(button()).toBeNull();
  });
});

describe("the password reset page", () => {
  it("is upstream's form while the link holds a token", async () => {
    await open("/reset-password?token=abc");
    expect(container.textContent).toContain("upstream reset form");
    expect(where()).toBe("/reset-password?token=abc");
  });

  it.each(["/reset-password?error=INVALID_TOKEN", "/reset-password"])(
    "shows %s as a link that no longer works, with the way to a new one",
    async (path) => {
      await open(path);
      expect(title()).toBe("This link is no longer valid");
      expect(links()).toEqual(["Request a new link /forgot-password", "Back to sign in /sign-in"]);
      expect(where()).toBe("/reset-password");
    },
  );
});
