// @vitest-environment jsdom
// Upstream's password form on the branded tree: the brand rule sends a code when the server refuses
// a password sign-in because the email was never confirmed. Runs on the staged tree only.
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth/auth";
import type { AuthCapabilities } from "../lib/auth/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth/auth-capabilities";
import type * as Passkeys from "../lib/auth/passkeys";
import { AuthPage } from "./auth/Auth";

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
    variant,
    size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button data-variant={variant ?? "default"} data-size={size} {...props}>
      {children}
    </button>
  ),
  LogoAvatar: () => <svg aria-hidden="true" data-rakazo-logo="" />,
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  InputOTP: ({
    maxLength,
    onChange,
    onComplete,
    children: _children,
    ...props
  }: Omit<React.ComponentProps<"input">, "onChange"> & {
    onChange: (value: string) => void;
    onComplete?: (value: string) => void;
  }) => (
    <input
      {...props}
      data-otp=""
      onChange={(event) => {
        onChange(event.target.value);
        if (event.target.value.length === maxLength) onComplete?.(event.target.value);
      }}
    />
  ),
  InputOTPGroup: () => null,
  InputOTPSlot: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipContent: () => null,
  Label: ({ children, htmlFor, ...props }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
}));
vi.mock("../lib/auth/auth-capabilities", () => ({ fetchAuthCapabilities: vi.fn() }));
vi.mock("../lib/auth/auth", () => ({
  authClient: {
    signIn: {
      social: vi.fn(async () => ({})),
      email: vi.fn(),
      emailOtp: vi.fn(),
      passkey: vi.fn(async () => ({ data: {}, error: null })),
    },
    emailOtp: { sendVerificationOtp: vi.fn() },
  },
}));
vi.mock("../lib/query/rpc", () => ({ clearSpaceSelection: vi.fn() }));
vi.mock("../lib/auth/passkeys", async (importActual) => ({
  ...(await importActual<typeof Passkeys>()),
  usePasskeysSupported: vi.fn(() => false),
  conditionalPasskeyAvailable: vi.fn(async () => false),
}));

const codeCapabilities: AuthCapabilities = {
  passwordAuth: true,
  emailCode: true,
  sso: null,
  passwordReset: false,
  resetUrl: null,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function enter(input: Element | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function signInWithPassword(refusal: unknown, mode: "in" | "up" = "in") {
  vi.mocked(authClient.signIn.email).mockResolvedValue({ data: null, error: refusal } as never);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthPage mode={mode} />
      </MemoryRouter>,
    ),
  );
  await enter(host.querySelector('input[name="email"]'), "maya@example.com");
  await enter(host.querySelector('input[type="password"]'), "a-long-password");
  await act(async () => host.querySelector("form")?.requestSubmit());
}

const alert = () => host.querySelector('[role="alert"]')?.textContent;

it("sends a code and shows the code step when the password sign-in is refused as unverified", async () => {
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  await signInWithPassword({ status: 403, code: "EMAIL_NOT_VERIFIED", message: "unverified" });
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
    email: "maya@example.com",
    type: "sign-in",
  });
  expect(host.querySelector("h1")?.textContent).toBe("Check your email");
  expect(host.querySelector('input[aria-label="Code"]')).not.toBeNull();
});

it("only shows the error for a wrong password, and sends no code", async () => {
  await signInWithPassword({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD", message: "no" });
  expect(authClient.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
  expect(host.querySelector('input[aria-label="Code"]')).toBeNull();
  expect(alert()).toBeTruthy();
});

it("shows the error when the code cannot be sent, and stays on the form", async () => {
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: null,
    error: { status: 429, message: "Too many requests" },
  } as never);
  await signInWithPassword({ status: 403, code: "EMAIL_NOT_VERIFIED", message: "unverified" });
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(1);
  expect(host.querySelector('input[aria-label="Code"]')).toBeNull();
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(alert()).toBeTruthy();
});
