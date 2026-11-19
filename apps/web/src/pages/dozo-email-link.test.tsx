// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SessionUser = { email: string; emailVerified: boolean };
const api = vi.hoisted(() => ({
  session: { isPending: false, data: null as { user: SessionUser } | null },
  send: vi.fn(),
  capabilities: vi.fn(),
  mark: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  authClient: { useSession: () => api.session, sendVerificationEmail: api.send },
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: api.capabilities }));
vi.mock("../lib/user-error", () => ({
  authErrorText: (error: { code?: string }, fallback: string) =>
    error.code === "TOO_MANY_REQUESTS" ? "Too many attempts" : fallback,
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

import { errorOutcome, PasswordResetPage, VerifyEmailPage } from "./dozo-email-link";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let goTo: ((path: string) => void) | undefined;

function Where() {
  const { pathname, search } = useLocation();
  goTo = useNavigate();
  return <output>{pathname + search}</output>;
}

let handed: unknown;
function SignIn() {
  handed = useLocation().state;
  return <p>sign-in</p>;
}

async function open(path: string | { pathname: string; state: unknown }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route path="/reset-password" element={<PasswordResetPage />} />
            <Route path="/sign-in/email" element={<SignIn />} />
            <Route path="/" element={<p>home</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
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
  api.mark.mockReset();
  api.mark.mockResolvedValue({ verified: true, email: "ada@example.com" });
  handed = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const mark = new URL(url, "https://app.example.com").searchParams.get("v");
      return Response.json(await api.mark(mark));
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("errorOutcome", () => {
  it.each([
    ["TOKEN_EXPIRED", "expired"],
    ["INVALID_TOKEN", "invalid"],
    ["USER_NOT_FOUND", "invalid"],
    ["INVALID_USER", "invalid"],
    ["SOMETHING_NEW", "unknown"],
  ])("maps %j to %s", (code, outcome) => {
    expect(errorOutcome(code)).toBe(outcome);
  });
});

const signedIn = (emailVerified: boolean) => ({
  isPending: false,
  data: { user: { email: "ada@example.com", emailVerified } },
});

describe("the verification result page", () => {
  it("says verified when the server confirms the marked account, and hands the address to sign-in", async () => {
    await open("/verify-email?v=mark-1");
    await vi.waitFor(() => expect(title()).toBe("Email verified"));
    expect(api.mark).toHaveBeenCalledWith("mark-1");
    expect(where()).toBe("/verify-email");
    expect(links()).toEqual(["Continue /sign-in/email"]);
    await act(async () => container.querySelector("a")?.click());
    expect(where()).toBe("/sign-in/email");
    expect(handed).toEqual({ email: "ada@example.com" });
  });

  it("sends a signed-in reader into the app", async () => {
    api.session = signedIn(true);
    await open("/verify-email?v=mark-1");
    await vi.waitFor(() => expect(title()).toBe("Email verified"));
    expect(links()).toEqual(["Continue /app"]);
  });

  it("never says verified on its own: a hand-made link gets a neutral screen", async () => {
    api.mark.mockResolvedValue({ verified: false, email: null });
    await open("/verify-email?v=forged");
    await vi.waitFor(() => expect(title()).toBe("Sign in to continue"));
    expect(links()).toEqual(["Sign in /sign-in/email"]);
  });

  it("trusts the session for a signed-in reader without a mark", async () => {
    api.session = signedIn(true);
    await open("/verify-email?error=");
    expect(title()).toBe("Email verified");
    expect(api.mark).not.toHaveBeenCalled();
  });

  it("is neutral for a signed-in reader still unverified, and when the server cannot answer", async () => {
    api.session = signedIn(false);
    api.mark.mockRejectedValue(new Error("offline"));
    await open("/verify-email?v=mark-1");
    await vi.waitFor(() => expect(title()).toBe("Continue to Dozo"));
    expect(links()).toEqual(["Continue /app"]);
  });

  it("keeps the screen on a reload, from the history entry", async () => {
    await open({ pathname: "/verify-email", state: { error: "TOKEN_EXPIRED", mark: "mark-1" } });
    await vi.waitFor(() => expect(title()).toBe("This link has expired"));
    await vi.waitFor(() => expect(field()?.value).toBe("ada@example.com"));
  });

  it("goes home when it has nothing to say", async () => {
    await open("/verify-email?v=mark-1&error=USER_NOT_FOUND");
    await vi.waitFor(() => expect(where()).toBe("/verify-email"));
    await act(async () => goTo?.("/verify-email"));
    expect(where()).toBe("/");
  });

  it.each(["INVALID_TOKEN", "USER_NOT_FOUND", "INVALID_USER"])(
    "says %s is no longer valid, and offers sign-in",
    async (code) => {
      api.mark.mockResolvedValue({ verified: false, email: null });
      await open(`/verify-email?v=mark-1&error=${code}`);
      await vi.waitFor(() => expect(title()).toBe("This link is no longer valid"));
      expect(links()).toEqual(["Sign in /sign-in/email"]);
      expect(where()).toBe("/verify-email");
    },
  );

  it("says an unknown code in general words, even if the account is verified", async () => {
    await open("/verify-email?v=mark-1&error=SOMETHING_NEW");
    await vi.waitFor(() => expect(title()).toBe("Could not open this link"));
  });

  it("waits for the session before choosing the buttons", async () => {
    api.session = { isPending: true, data: null };
    await open("/verify-email?v=mark-1");
    expect(title()).toBeUndefined();
  });
});

describe("an expired verification link", () => {
  it("asks a signed-out reader for the address, filled in from the server, and sends a new link", async () => {
    api.send.mockResolvedValue({ data: { status: true }, error: null });
    await open("/verify-email?v=mark-1&error=TOKEN_EXPIRED");
    await vi.waitFor(() => expect(button()?.textContent).toBe("Send a new link"));
    expect(title()).toBe("This link has expired");
    expect(field()?.value).toBe("ada@example.com");
    await type("  grace@example.com ");
    await submit();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        "We sent a new link to grace@example.com.",
      ),
    );
    expect(api.send).toHaveBeenCalledWith({ email: "grace@example.com" });
    expect(button()).toBeNull();
    expect(links()).toEqual(["Sign in /sign-in/email"]);
  });

  it("sends a signed-in reader's link in one tap, without a field", async () => {
    api.session = signedIn(false);
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
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Too many attempts"),
    );
    expect(button()?.disabled).toBe(false);
  });

  it("says so when the request does not reach the server", async () => {
    api.send.mockRejectedValue(new TypeError("Failed to fetch"));
    await open("/verify-email?v=mark-1&error=TOKEN_EXPIRED");
    await vi.waitFor(() => expect(button()).not.toBeNull());
    await submit();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Could not send the link",
      ),
    );
  });

  it("offers no new link from a server that sends no mail, or when it cannot tell", async () => {
    api.capabilities.mockResolvedValue({ emailCode: false });
    await open("/verify-email?v=mark-1&error=TOKEN_EXPIRED");
    await vi.waitFor(() => expect(api.capabilities).toHaveBeenCalled());
    expect(button()).toBeNull();
    expect(field()).toBeNull();
    expect(links()).toEqual(["Sign in /sign-in/email"]);
    act(() => root.unmount());
    root = createRoot(container);
    api.capabilities.mockRejectedValue(new Error("offline"));
    await open("/verify-email?error=TOKEN_EXPIRED");
    await vi.waitFor(() => expect(title()).toBe("This link has expired"));
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
