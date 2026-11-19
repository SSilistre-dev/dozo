// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: the brand rules give upstream's sign-in form its field errors.

const auth = vi.hoisted(() => ({ email: vi.fn() }));
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
  Button: ({ children, ...props }: React.ComponentProps<"button"> & { variant?: string }) => {
    const { variant: _variant, size: _size, ...rest } = props as typeof props & { size?: string };
    return <button {...rest}>{children}</button>;
  },
  LogoAvatar: () => null,
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  InputOTP: () => null,
  InputOTPGroup: () => null,
  InputOTPSlot: () => null,
  Label: ({ children, htmlFor }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));
vi.mock("../lib/auth-capabilities", () => ({
  fetchAuthCapabilities: async () => ({
    passwordAuth: true,
    sso: null,
    passwordReset: false,
    resetUrl: null,
  }),
}));
vi.mock("../lib/auth", () => ({ authClient: { signIn: { email: auth.email } } }));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));
vi.mock("../lib/passkeys", () => ({
  usePasskeysSupported: () => false,
  conditionalPasskeyAvailable: async () => false,
  passkeyErrorText: () => null,
}));
vi.mock("../components/PasskeySignIn", () => ({
  PasskeySignIn: () => null,
  usePasskeySignIn: () => ({ supported: false, pending: false, start: () => undefined }),
}));

import { AuthPage } from "./Auth";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  auth.email.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function open() {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AuthPage mode="in" />
      </MemoryRouter>,
    ),
  );
  const form = host.querySelector("form") as HTMLFormElement;
  const email = host.querySelector('input[name="email"]') as HTMLInputElement;
  const password = host.querySelector('input[name="password"]') as HTMLInputElement;
  const submit = () => act(async () => form.requestSubmit());
  return { form, email, password, submit };
}

it("checks the fields itself and names the empty one under it, never in the browser's bubble", async () => {
  const { form, email, password, submit } = await open();
  expect(form.noValidate).toBe(true);
  expect(email.required).toBe(true);

  await submit();
  const issue = host.querySelector("#email-issue");
  expect(issue?.textContent).toBe("Enter a valid email");
  expect(issue?.getAttribute("role")).toBe("alert");
  expect(issue?.className).toBe("mt-2 text-body-sm text-destructive");
  expect(email.getAttribute("aria-invalid")).toBe("true");
  expect(email.getAttribute("aria-describedby")).toBe("email-issue");
  expect(email.parentElement?.contains(issue as Node)).toBe(true);
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);

  await enter(email, "ada@example.com");
  await submit();
  expect(host.querySelector("#email-issue")).toBeNull();
  expect(email.hasAttribute("aria-invalid")).toBe(false);
  expect(host.querySelector("#password-issue")?.textContent).toBe("Enter a password");
  expect(password.getAttribute("aria-describedby")).toBe("password-issue");
  expect(auth.email).not.toHaveBeenCalled();
});

it("says a refused sign-in in its own words below the form", async () => {
  auth.email.mockResolvedValue({
    error: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password", status: 401 },
  });
  const { email, password, submit } = await open();
  await enter(email, "ada@example.com");
  await enter(password, "wrong-password");
  await submit();
  const alerts = [...host.querySelectorAll('[role="alert"]')];
  expect(alerts.map((alert) => alert.textContent)).toEqual(["Incorrect email or password"]);
  expect(alerts[0]?.id).toBe("");
  expect(email.hasAttribute("aria-invalid")).toBe(false);
  expect(password.hasAttribute("aria-invalid")).toBe(false);
});
