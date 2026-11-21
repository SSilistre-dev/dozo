// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import type * as Passkeys from "../lib/passkeys";
import { clearSpaceSelection } from "../lib/rpc";
import { AuthPage } from "./Auth";

// A server with a mail provider opens no session at sign-up and refuses an unverified account's
// password sign-in. The page answers with "Check your email" and never enters the app, and says
// "Email verification required" for the refusal. The wiring tests run on the branded tree only.

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings
        ? strings.message
        : strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<"button"> & {
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
  LogoAvatar: () => <svg aria-hidden="true" />,
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  InputOTP: () => null,
  InputOTPGroup: () => null,
  InputOTPSlot: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipContent: () => null,
  Label: ({ children, htmlFor }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: vi.fn() }));
vi.mock("../lib/auth", () => ({
  authClient: {
    signIn: { social: vi.fn(), email: vi.fn(), emailOtp: vi.fn(), passkey: vi.fn() },
    signUp: { email: vi.fn() },
    emailOtp: { sendVerificationOtp: vi.fn() },
  },
}));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));
vi.mock("../lib/passkeys", async (importActual) => ({
  ...(await importActual<typeof Passkeys>()),
  usePasskeysSupported: () => false,
  conditionalPasskeyAvailable: async () => false,
}));

const capabilities: AuthCapabilities = {
  passwordAuth: true,
  sso: null,
  passwordReset: false,
  resetUrl: null,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(mode: "in" | "up") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthPage mode={mode} />
      </MemoryRouter>,
    ),
  );
}
async function enter(name: string, value: string) {
  await act(async () => {
    const input = host.querySelector(`input[name="${name}"]`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => host.querySelector("form")?.requestSubmit());
}
async function fillAndSubmit(mode: "in" | "up") {
  await render(mode);
  if (mode === "up") await enter("name", "Ada");
  await enter("email", "ada@example.test");
  await enter("password", "example-password-12");
  await submit();
}

it("sign-up that returns no token shows Check your email and does not enter the app", async () => {
  vi.mocked(authClient.signUp.email).mockResolvedValue({
    data: { token: null, user: { id: "u1" } },
    error: null,
  } as never);
  await fillAndSubmit("up");
  expect(authClient.signUp.email).toHaveBeenCalledWith({
    email: "ada@example.test",
    password: "example-password-12",
    name: "Ada",
  });
  expect(host.querySelector("h1")?.textContent).toBe("Check your email");
  expect(clearSpaceSelection).not.toHaveBeenCalled();
});

it("a repeated sign-up gets the same answer, so the screen is the same", async () => {
  vi.mocked(authClient.signUp.email).mockResolvedValue({
    data: { token: null, user: { id: "someone-else" } },
    error: null,
  } as never);
  await fillAndSubmit("up");
  expect(host.querySelector("h1")?.textContent).toBe("Check your email");
  expect(host.querySelector('input[name="password"]')).toBeNull();
});

it("a sign-up that opens a session still goes into the app", async () => {
  vi.mocked(authClient.signUp.email).mockResolvedValue({
    data: { token: "session-token", user: { id: "u1" } },
    error: null,
  } as never);
  await fillAndSubmit("up");
  expect(clearSpaceSelection).toHaveBeenCalledOnce();
  expect(host.querySelector("h1")?.textContent).not.toBe("Check your email");
});

it("a sign-in the server refuses for an unverified address says so in the fork's words", async () => {
  vi.mocked(authClient.signIn.email).mockResolvedValue({
    data: null,
    error: { code: "EMAIL_NOT_VERIFIED", status: 403, message: "Email not verified" },
  } as never);
  await fillAndSubmit("in");
  expect(authClient.signIn.email).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Email verification required");
  expect(host.textContent).not.toContain("Email not verified");
  expect(clearSpaceSelection).not.toHaveBeenCalled();
});
