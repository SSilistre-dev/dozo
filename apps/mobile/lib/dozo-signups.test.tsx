// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SignIn from "../app/sign-in";
import { passwordResetCapabilities } from "./api-auth";
import { authModeFor, signupsAreClosed, titleWhenKnown } from "./dozo-signups";
import type * as Endpoint from "./endpoint";

// Runs on the branded tree (`make qa`): the screen under test is upstream's sign-in after the
// closed-registration rules in dozo/brand/brand.json, so the texts carry the Dozo name.

const route = vi.hoisted(() => ({ mode: "up" as string | undefined }));
const server = vi.hoisted(() => ({ base: "https://one.example.invalid", refocus: () => {} }));

vi.mock("expo-router", () => ({
  Redirect: () => null,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => route,
  useFocusEffect: (effect: () => void) => {
    server.refocus = effect;
  },
}));
vi.mock("react-native", () => {
  // A view styled `display: "none"` draws nothing, as on the device.
  const Container = ({
    children,
    style,
  }: {
    children?: ReactNode;
    style?: { display?: string };
  }) => (style?.display === "none" ? null : <div>{children}</div>);
  return {
    Platform: { OS: "ios" },
    Keyboard: { dismiss: vi.fn() },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    KeyboardAvoidingView: Container,
    TouchableWithoutFeedback: Container,
    ActivityIndicator: () => <div role="progressbar" />,
    View: Container,
    ScrollView: Container,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput: ({
      accessibilityLabel,
      placeholder,
    }: {
      accessibilityLabel?: string;
      placeholder?: string;
    }) => <input aria-label={accessibilityLabel ?? placeholder} readOnly />,
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/social-sign-in-buttons", () => ({ SocialSignInButtons: () => null }));
vi.mock("./native", () => ({ useMobileTokens: () => tokensForAppearance("dark") }));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ currentApiBase: () => server.base, rpc: vi.fn() }));
vi.mock("./endpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof Endpoint>()),
  displayApiHost: () => "one.example.invalid",
  usesCustomApiBase: () => false,
}));
vi.mock("./session", () => ({ loadSessionToken: vi.fn().mockResolvedValue(null) }));
vi.mock("./api-auth", () => ({
  passwordResetCapabilities: vi.fn(),
  requestPasswordReset: vi.fn(),
  sendSignInCode: vi.fn(),
  signIn: vi.fn(),
  signInWithCode: vi.fn(),
  signUp: vi.fn(),
}));
vi.mock("./incoming-share", () => ({ hasIncomingShare: () => false }));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));
vi.mock("./passkey", () => ({
  passkeysAvailable: vi.fn().mockResolvedValue(false),
  signInWithPasskey: vi.fn(),
}));
vi.mock("./unsent-send-warning", () => ({ confirmUnsentSendLoss: vi.fn() }));
vi.mock("./user-error", () => ({ credentialIssueText: vi.fn(), errorText: vi.fn() }));

const base = {
  passwordAuth: true,
  passwordReset: true,
  resetUrl: "https://one.example.invalid/reset",
  sso: null,
};
type Capabilities = Awaited<ReturnType<typeof passwordResetCapabilities>>;
const answer = (extra: object) => ({ ...base, ...extra }) as Capabilities;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  route.mode = undefined;
  server.base = "https://one.example.invalid";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<SignIn />));
const text = () => host.textContent?.replace(/\s+/g, " ") ?? "";
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

it("a server with registration closed opens on sign-in, with no way to sign-up", async () => {
  vi.mocked(passwordResetCapabilities).mockResolvedValue(answer({ signupsOpen: false }));
  await render();
  expect(text()).toContain("Sign in to Dozo");
  expect(text()).not.toContain("Sign up");
  expect(text()).not.toContain("Don’t have an account?");
  expect(host.querySelector('input[aria-label="Name"]')).toBeNull();
  // The way to the reset form and back stays.
  await act(async () => button("Forgot password?")!.click());
  expect(text()).toContain("Reset your password");
  await act(async () => button("Back to sign in")!.click());
  expect(text()).toContain("Sign in to Dozo");
  expect(text()).not.toContain("Sign up");
});

it("a closed server never shows the sign-up title while its answer is on the way", async () => {
  const pending = deferred<Capabilities>();
  vi.mocked(passwordResetCapabilities).mockReturnValue(pending.promise);
  await render();
  expect(text()).not.toContain("Sign up");
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  await act(async () => pending.resolve(answer({ signupsOpen: false })));
  expect(text()).toContain("Sign in to Dozo");
});

it.each([
  ["open", { signupsOpen: true }],
  ["a server that does not say", {}],
])(
  "registration %s: the screen is upstream's, sign-up first with a link to sign-in",
  async (_name, extra) => {
    vi.mocked(passwordResetCapabilities).mockResolvedValue(answer(extra));
    await render();
    expect(text()).toContain("Sign up for Dozo");
    expect(host.querySelector('input[aria-label="Name"]')).not.toBeNull();
    await act(async () => button("Sign in")!.click());
    expect(text()).toContain("Sign in to Dozo");
    expect(text()).toContain("Don’t have an account?");
    await act(async () => button("Sign up")!.click());
    expect(text()).toContain("Sign up for Dozo");
  },
);

it("a failed capabilities request keeps upstream's title and retry", async () => {
  vi.mocked(passwordResetCapabilities).mockRejectedValue(new Error("offline"));
  await render();
  expect(text()).toContain("Sign up for Dozo");
  expect(button("Retry")).toBeDefined();
});

it("reads the answer again when the server changes", async () => {
  vi.mocked(passwordResetCapabilities).mockResolvedValue(answer({ signupsOpen: false }));
  await render();
  expect(text()).toContain("Sign in to Dozo");
  server.base = "https://two.example.invalid";
  vi.mocked(passwordResetCapabilities).mockResolvedValue(answer({}));
  await act(async () => server.refocus());
  expect(text()).toContain("Sign up for Dozo");
  expect(button("Sign in")).toBeDefined();
});

it("the helpers: closed only on an explicit false, and only sign-up is redirected", () => {
  expect(signupsAreClosed(null)).toBe(false);
  expect(signupsAreClosed({})).toBe(false);
  expect(signupsAreClosed({ signupsOpen: true })).toBe(false);
  expect(signupsAreClosed({ signupsOpen: false })).toBe(true);
  expect(authModeFor("up", { signupsOpen: false })).toBe("in");
  expect(authModeFor("forgot", { signupsOpen: false })).toBe("forgot");
  expect(authModeFor("up", null)).toBe("up");
  expect(titleWhenKnown(null, "t")).toBe("");
  expect(titleWhenKnown(true, "t")).toBe("t");
});
