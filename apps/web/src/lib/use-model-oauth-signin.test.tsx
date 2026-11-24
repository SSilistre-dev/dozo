// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useModelOAuthSignIn } from "./use-model-oauth-signin";

const models = vi.hoisted(() => ({
  beginOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  submitOAuthCode: vi.fn(),
}));
const waitForModelOAuth = vi.hoisted(() => vi.fn());
vi.mock("./space-rpc", () => ({ useSpaceRpc: () => ({ models }) }));
vi.mock("./desktop", () => ({
  desktopBridge: () => undefined,
  oauthStateOf: () => undefined,
  onDesktopOAuthCallback: vi.fn(),
}));
vi.mock("./model-auth", () => ({
  waitForModelOAuth,
}));

const verificationUri = "https://example.test/device";
let latest: ReturnType<typeof useModelOAuthSignIn>;
let root: Root;
let container: HTMLDivElement;
const onError = vi.fn();
function Harness() {
  latest = useModelOAuthSignIn({ onFinished: vi.fn(), onError });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  models.beginOAuth.mockResolvedValue({
    mode: "device-code",
    loginId: "login",
    verificationUri,
    userCode: "ABCD-1234",
    expiresInSeconds: 300,
  });
  models.cancelOAuth.mockResolvedValue(undefined);
  models.submitOAuthCode.mockResolvedValue(undefined);
  waitForModelOAuth.mockImplementation(
    (_loginId: string, signal: AbortSignal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("reports an opened tab without treating noopener's null result as a block", async () => {
  const document = window.document.implementation.createHTMLDocument();
  const popup = { opener: window, document };
  const navigate = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(popup.opener).toBeNull();
    expect(this.rel).toBe("noreferrer");
    expect(this.href).toBe(verificationUri);
  });
  // A browser opens the tab but returns null when noopener/noreferrer is requested.
  vi.spyOn(window, "open").mockImplementation((_url, _target, features) =>
    features?.includes("noopener") || features?.includes("noreferrer")
      ? null
      : (popup as unknown as Window),
  );
  await act(async () => {
    void latest.startSubscriptionSignIn({ provider: "subscription" });
  });
  expect(latest.popupBlocked).toBe(false);
  expect(navigate).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});

it("reports a blocked tab and keeps the manual sign-in details", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => {
    void latest.startSubscriptionSignIn({ provider: "subscription" });
  });
  expect(latest.popupBlocked).toBe(true);
  expect(latest.oauth?.verificationUri).toBe(verificationUri);
  expect(onError).not.toHaveBeenCalled();
});

it("shows connecting from submit until the sign-in ends, checking every second", async () => {
  models.beginOAuth.mockResolvedValue({
    mode: "auth-url",
    loginId: "login",
    verificationUri,
    expiresInSeconds: 300,
  });
  vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => {
    void latest.startSubscriptionSignIn({ provider: "subscription" });
  });
  expect(latest.oauthSubmitting).toBe(false);

  await act(async () => {
    void latest.submitOAuthCode("pasted-code");
  });
  expect(latest.oauthSubmitting).toBe(true);
  expect(waitForModelOAuth).toHaveBeenCalledWith(
    "login",
    expect.anything(),
    expect.anything(),
    1000,
  );

  await act(async () => latest.cancelOAuthAttempt());
  expect(latest.oauthSubmitting).toBe(false);
});

it("lets the code be submitted again after a rejected submit", async () => {
  models.beginOAuth.mockResolvedValue({
    mode: "auth-url",
    loginId: "login",
    verificationUri,
    expiresInSeconds: 300,
  });
  models.submitOAuthCode.mockRejectedValue(new Error("bad code"));
  vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => {
    void latest.startSubscriptionSignIn({ provider: "subscription" });
  });
  await act(async () => {
    await latest.submitOAuthCode("pasted-code");
  });
  expect(latest.oauthSubmitting).toBe(false);
  expect(latest.pasteCode).toBe("pasted-code");
  expect(onError).toHaveBeenCalled();
});
