// @vitest-environment jsdom
import type { FormEvent, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  verify: vi.fn(),
  social: vi.fn(),
  sso: vi.fn(),
  clear: vi.fn(),
  passkeyStart: vi.fn(),
  passkeySupported: false,
  providers: vi.fn(),
  now: 0,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings
        ? strings.message
        : strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/chat-ui/hooks", () => ({ useNow: () => mocks.now }));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button"> & { size?: string }) => {
    const { size: _size, ...rest } = props;
    return <button {...rest}>{children}</button>;
  },
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  // One input stands for the six boxes; a full value completes the code, as input-otp does.
  InputOTP: (props: {
    value: string;
    disabled?: boolean;
    "aria-label": string;
    autoComplete: string;
    inputMode: "numeric";
    onChange: (value: string) => void;
    onComplete: (value: string) => void;
  }) => (
    <input
      data-testid="code"
      aria-label={props["aria-label"]}
      autoComplete={props.autoComplete}
      inputMode={props.inputMode}
      disabled={props.disabled}
      value={props.value}
      onChange={(event) => {
        props.onChange(event.target.value);
        if (event.target.value.length === 6) props.onComplete(event.target.value);
      }}
    />
  ),
  InputOTPGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  InputOTPSlot: () => null,
}));
vi.mock("../lib/auth", () => ({
  authClient: {
    emailOtp: { sendVerificationOtp: mocks.send },
    signIn: { emailOtp: mocks.verify, social: mocks.social },
  },
}));
vi.mock("../lib/sso-flow", () => ({ runSsoFlow: mocks.sso }));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: mocks.clear }));
vi.mock("../components/PasskeySignIn", () => ({
  usePasskeySignIn: () => ({
    supported: mocks.passkeySupported,
    pending: false,
    start: mocks.passkeyStart,
  }),
}));
vi.mock("../components/SocialSignInButtons", () => ({
  SocialSignInButtons: (props: { providers: { id: string }[]; onPress: (id: string) => void }) => {
    mocks.providers(props.providers);
    return (
      <div>
        {props.providers.map((provider) => (
          <button key={provider.id} type="button" onClick={() => props.onPress(provider.id)}>
            {provider.id}
          </button>
        ))}
      </div>
    );
  },
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
    <form noValidate onSubmit={onSubmit}>
      <h1>{title}</h1>
      {children}
    </form>
  ),
}));
vi.mock("./dozo-signup-terms", () => ({ DozoSignupTerms: () => <p>terms</p> }));

import type { SignInProvider } from "@rakazo/contracts";
import { DozoCodeSignIn, RESEND_AFTER_MS } from "./dozo-code-sign-in";
import { DozoEmailCodeLink, dozoCodeSignInAvailable } from "./dozo-email-code-link";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let clock = 1_000_000;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [mocks.send, mocks.verify, mocks.social, mocks.sso, mocks.clear])
    mock.mockReset();
  mocks.providers.mockClear();
  mocks.passkeyStart.mockClear();
  mocks.passkeySupported = false;
  clock = 1_000_000;
  mocks.now = clock;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  mocks.send.mockResolvedValue({ data: { success: true }, error: null });
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

function Where() {
  const location = useLocation();
  return (
    <output>
      {location.pathname + location.search}|{JSON.stringify(location.state)}
    </output>
  );
}

async function open(
  path = "/sign-in",
  providers: SignInProvider[] = [],
  state: unknown = undefined,
) {
  await act(async () =>
    root.render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: path.split("?")[0] ?? path,
            search: path.includes("?") ? `?${path.split("?")[1]}` : "",
            state,
          },
        ]}
      >
        <Where />
        <Routes>
          <Route path="/sign-in" element={<DozoCodeSignIn providers={providers} />} />
          <Route path="/sign-in/email" element={<p>password form</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

const text = () => host.textContent ?? "";
const where = () => host.querySelector("output")?.textContent ?? "";
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label)) as
    | HTMLButtonElement
    | undefined;
const alerts = () => [...host.querySelectorAll('[role="alert"]')].map((el) => el.textContent);

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const emailField = () =>
  host.querySelector<HTMLInputElement>('input[name="email"]') as HTMLInputElement;
const submit = () => act(async () => host.querySelector("form")?.requestSubmit());

async function toCode(address = "maya@example.com") {
  await type(emailField(), address);
  await submit();
}

it("asks for the address alone, with autofill for a passkey, and names a bad one under the field", async () => {
  await open();
  expect(text()).toContain("Sign in to Rakazo");
  expect(emailField().autocomplete).toBe("username webauthn");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  await toCode("not-an-address");
  expect(mocks.send).not.toHaveBeenCalled();
  expect(emailField().getAttribute("aria-invalid")).toBe("true");
  expect(emailField().getAttribute("aria-describedby")).toBe("email-issue");
  expect(alerts()).toHaveLength(1);
});

it("mails a sign-in code with upstream's own call, then shows the code step for that address", async () => {
  await open();
  await toCode(" maya@example.com ");
  expect(mocks.send).toHaveBeenCalledWith({ email: "maya@example.com", type: "sign-in" });
  expect(text()).toContain("Check your email");
  expect(text()).toContain("maya@example.com");
  const code = host.querySelector<HTMLInputElement>('[data-testid="code"]') as HTMLInputElement;
  expect(code.getAttribute("aria-label")).toBe("Code");
  expect(code.autocomplete).toBe("one-time-code");
  expect(code.inputMode).toBe("numeric");
  expect(text()).toContain("terms");
});

it("stays on the address when sending fails, saying why in one line", async () => {
  mocks.send.mockResolvedValueOnce({ error: { status: 429, message: "Too many requests" } });
  await open();
  await toCode();
  expect(text()).not.toContain("Check your email");
  expect(alerts()).toEqual(["Too many requests"]);
  mocks.send.mockRejectedValueOnce(new Error("offline"));
  await submit();
  expect(alerts()).toEqual(["Could not reach the server"]);
});

it("signs in on the sixth digit, and a wrong code clears the boxes with one line of error", async () => {
  mocks.verify.mockResolvedValueOnce({ error: { code: "INVALID_OTP", message: "Invalid OTP" } });
  await open();
  await toCode();
  const code = () =>
    host.querySelector<HTMLInputElement>('[data-testid="code"]') as HTMLInputElement;
  await type(code(), "12345");
  expect(mocks.verify).not.toHaveBeenCalled();
  await type(code(), "123456");
  expect(mocks.verify).toHaveBeenCalledWith({ email: "maya@example.com", otp: "123456" });
  expect(alerts()).toEqual(["Invalid code"]);
  expect(code().value).toBe("");
  expect(host.querySelector("[data-dozo-code]")?.hasAttribute("data-missed")).toBe(true);
  expect(mocks.clear).not.toHaveBeenCalled();

  // Typing again clears the error; a right code enters the app.
  await type(code(), "6");
  expect(alerts()).toEqual([]);
  mocks.verify.mockResolvedValueOnce({ data: {}, error: null });
  await type(code(), "654321");
  expect(mocks.clear).toHaveBeenCalledTimes(1);
  expect(code().disabled).toBe(true);
});

it("submits a full code from the form too, never an unfinished one, and says a lost connection", async () => {
  mocks.verify.mockRejectedValueOnce(new Error("offline"));
  await open();
  await toCode();
  await submit();
  expect(mocks.verify).not.toHaveBeenCalled();
  const code = host.querySelector<HTMLInputElement>('[data-testid="code"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(code, "11111");
    code.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await submit();
  expect(mocks.verify).not.toHaveBeenCalled();
  await type(code, "111111");
  expect(alerts()).toEqual(["Could not reach the server"]);
});

it("lets Resend code ask again only after 30 seconds, showing the wait, and shows the server's refusal", async () => {
  await open();
  await toCode();
  const resend = () => button("Resend code") as HTMLButtonElement;
  const code = () =>
    host.querySelector<HTMLInputElement>('[data-testid="code"]') as HTMLInputElement;
  expect(resend().disabled).toBe(true);
  expect(resend().textContent).toBe("Resend code0:30");
  // The clock is read on each render; typing a digit renders again.
  mocks.now = clock + 12_000;
  await type(code(), "1");
  expect(resend().textContent).toBe("Resend code0:18");
  mocks.now = clock + RESEND_AFTER_MS;
  await type(code(), "12");
  expect(resend().disabled).toBe(false);
  expect(resend().textContent).toBe("Resend code");

  // The server's limit is its own: a refusal is said in one line and the step stays.
  mocks.send.mockResolvedValueOnce({ error: { status: 429, message: "Too many requests" } });
  await act(async () => resend().click());
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(alerts()).toEqual(["Too many requests"]);
  expect(text()).toContain("Check your email");
  expect(code().value).toBe("");

  // A code sent again starts the wait again.
  clock = mocks.now;
  await act(async () => resend().click());
  expect(mocks.send).toHaveBeenCalledTimes(3);
  expect(resend().disabled).toBe(true);
  expect(resend().textContent).toBe("Resend code0:30");
});

it("goes Back to the address, keeping it", async () => {
  await open();
  await toCode();
  await act(async () => button("Back")?.click());
  expect(text()).toContain("Sign in to Rakazo");
  expect(emailField().value).toBe("maya@example.com");
});

it("opens the password form one step away, handing the address over in the history entry", async () => {
  await open("/sign-in?next=%2Fapp");
  await type(emailField(), " maya@example.com");
  await act(async () => button("Use a password instead")?.click());
  expect(text()).toContain("password form");
  expect(where()).toBe('/sign-in/email?next=%2Fapp|{"email":"maya@example.com"}');
});

it("starts from an address handed over in the history entry and shows an error from the address bar", async () => {
  await open("/sign-in?error=INVALID_OTP", [], { email: "kai@example.com" });
  expect(emailField().value).toBe("kai@example.com");
  expect(alerts()).toEqual(["Invalid code"]);
});

it("keeps the deployment's providers and passkey on the first step", async () => {
  mocks.passkeySupported = true;
  mocks.sso.mockResolvedValueOnce({ error: { message: "Denied" } });
  const google = { id: "google", name: "Google" } as SignInProvider;
  await open("/sign-in", [google]);
  expect(mocks.providers).toHaveBeenLastCalledWith([google]);
  await act(async () => button("Continue with passkey")?.click());
  expect(mocks.passkeyStart).toHaveBeenCalledTimes(1);
  await act(async () => button("google")?.click());
  expect(mocks.sso).toHaveBeenCalledTimes(1);
  expect(alerts()).toEqual(["Denied"]);
  // The flow builds upstream's social sign-in call.
  const [start] = mocks.sso.mock.calls[0] as [(d: boolean, cb: (p: string) => string) => unknown];
  start(true, (path) => `cb:${path}`);
  expect(mocks.social).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "google",
      callbackURL: "cb:/app",
      errorCallbackURL: "cb:/sign-in",
    }),
  );
  mocks.sso.mockRejectedValueOnce(new Error("popup closed"));
  await act(async () => button("google")?.click());
  expect(alerts()).toEqual(["Could not continue"]);
});

it("offers a way back from the password form only where the server signs in with a code", async () => {
  expect(dozoCodeSignInAvailable(null)).toBe(false);
  expect(dozoCodeSignInAvailable({ passwordAuth: true, emailCode: false } as never)).toBe(false);
  expect(dozoCodeSignInAvailable({ passwordAuth: false, emailCode: true } as never)).toBe(false);
  const capabilities = { passwordAuth: true, emailCode: true } as never;
  expect(dozoCodeSignInAvailable(capabilities)).toBe(true);

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/sign-in/email?next=%2Fapp"]}>
        <Where />
        <Routes>
          <Route
            path="/sign-in/email"
            element={
              <form>
                <input name="email" defaultValue=" kai@example.com " />
                <DozoEmailCodeLink capabilities={capabilities} />
              </form>
            }
          />
          <Route path="/sign-in" element={<p>code form</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () => button("Email me a code instead")?.click());
  expect(where()).toBe('/sign-in?next=%2Fapp|{"email":"kai@example.com"}');

  await act(async () =>
    root.render(
      <MemoryRouter>
        <DozoEmailCodeLink capabilities={{ passwordAuth: true, emailCode: false } as never} />
      </MemoryRouter>,
    ),
  );
  expect(button("Email me a code instead")).toBeUndefined();
});
