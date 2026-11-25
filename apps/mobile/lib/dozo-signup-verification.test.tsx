// @vitest-environment jsdom
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SignIn from "../app/sign-in";
import { rpc } from "./api/api";
import { passwordResetCapabilities, signUp } from "./auth/api-auth";
import type * as Endpoint from "./api/endpoint";
import { confirmUnsentSendLoss } from "./thread/send/unsent-send-warning";

// Runs on the branded tree (`make qa`). A server with a mail provider opens no session at sign-up:
// the screen answers with "Check your email" and does not go into the app.

const route = vi.hoisted(() => ({ mode: "up" as string | undefined }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const server = vi.hoisted(() => ({ base: "https://one.example.invalid", refocus: () => {} }));

vi.mock("expo-router", () => ({
  Redirect: () => null,
  useRouter: () => router,
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
      secureTextEntry,
      value,
      onChangeText,
    }: {
      accessibilityLabel?: string;
      placeholder?: string;
      secureTextEntry?: boolean;
      value?: string;
      onChangeText?: (value: string) => void;
    }) => (
      <input
        aria-label={accessibilityLabel ?? placeholder}
        type={secureTextEntry ? "password" : "text"}
        value={value}
        onChange={(event) => onChangeText?.(event.target.value)}
      />
    ),
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
vi.mock("../components/native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    prominence = "primary",
    onPress,
  }: {
    label: string;
    prominence?: string;
    onPress?: () => void;
  }) => (
    <button type="button" data-prominence={prominence} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/settings/social-sign-in-buttons", () => ({ SocialSignInButtons: () => null }));
vi.mock("./native/native", () => ({ useMobileTokens: () => tokensForAppearance("dark") }));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("./api/api-server", () => ({}));
vi.mock("./api/api-live", () => ({}));
vi.mock("./api/api", () => ({ currentApiBase: () => server.base, rpc: vi.fn() }));
vi.mock("./api/endpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof Endpoint>()),
  displayApiHost: () => "one.example.invalid",
  usesCustomApiBase: () => false,
}));
vi.mock("./api/session", () => ({ loadSessionToken: vi.fn().mockResolvedValue(null) }));
vi.mock("./auth/api-auth", () => ({
  passwordResetCapabilities: vi.fn(),
  requestPasswordReset: vi.fn(),
  sendSignInCode: vi.fn(),
  signIn: vi.fn(),
  signInWithCode: vi.fn(),
  signUp: vi.fn(),
}));
vi.mock("./composer/incoming-share", () => ({ hasIncomingShare: () => false }));
vi.mock("./auth/sso", () => ({ continueWithSso: vi.fn() }));
vi.mock("./auth/passkey", () => ({
  passkeysAvailable: vi.fn().mockResolvedValue(false),
  signInWithPasskey: vi.fn(),
}));
vi.mock("./thread/send/unsent-send-warning", () => ({ confirmUnsentSendLoss: vi.fn() }));
vi.mock("./user-error", () => ({ credentialIssueText: vi.fn(), errorText: vi.fn() }));
vi.mock("./dozo-relay-fetch", () => ({
  isRelayGone: () => false,
  relayApprovalCodeOf: async () => null,
  subscribeRelayState: () => () => {},
}));
vi.mock("./dozo-relay-sign-in", () => ({
  askComputerForSignIn: async () => "sign-in-on-computer",
}));
vi.mock("./platform/app-foreground", () => ({ useAppForeground: () => true }));

const capabilities = {
  passwordAuth: true,
  passwordReset: true,
  resetUrl: "https://one.example.invalid/reset",
  sso: null,
} as Awaited<ReturnType<typeof passwordResetCapabilities>>;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  route.mode = "up";
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(passwordResetCapabilities).mockResolvedValue(capabilities);
  vi.mocked(confirmUnsentSendLoss).mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const text = () => host.textContent?.replace(/\s+/g, " ") ?? "";
const input = (label: string) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
async function type(field: HTMLInputElement | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function signUpWith(result: { verificationRequired: boolean }) {
  vi.mocked(signUp).mockResolvedValue(result);
  vi.mocked(rpc).mockResolvedValue({ needsSignupSurvey: false } as never);
  await act(async () => root.render(<SignIn />));
  await type(input("Name"), "Ada");
  await type(input("Email"), " ada@example.test ");
  await type(input("Password"), "example-password-12");
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[data-prominence="primary"]')?.click(),
  );
}

it("a sign-up that needs the mailbox shows Check your email and does not enter the app", async () => {
  await signUpWith({ verificationRequired: true });
  expect(signUp).toHaveBeenCalledExactlyOnceWith("ada@example.test", "example-password-12", "Ada");
  expect(text()).toContain("Check your email");
  expect(button("Back to sign in")).toBeDefined();
  expect(router.replace).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
  expect(host.querySelector("input")).toBeNull();
});

it("its way back goes to sign-in", async () => {
  await signUpWith({ verificationRequired: true });
  await act(async () => button("Back to sign in")?.click());
  expect(text()).toContain("Sign in to Dozo");
  expect(text()).not.toContain("Check your email");
});

it("a sign-up that opened a session goes on into the app", async () => {
  await signUpWith({ verificationRequired: false });
  expect(router.replace).toHaveBeenCalledWith("/");
  expect(text()).not.toContain("Check your email");
});
