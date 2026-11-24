// @vitest-environment jsdom
import type { SignInProvider } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => <a href={href}>chats</a>,
}));

import { DozoStoreGate } from "../components/dozo-store-gate";
import {
  storeBuild,
  storeRunErrorDetails,
  storeSignInProviders,
} from "./dozo-store-build";

describe("the store build flag", () => {
  it("is off unless the bundle was made with EXPO_PUBLIC_DOZO_STORE_BUILD=1", () => {
    expect(process.env.EXPO_PUBLIC_DOZO_STORE_BUILD).toBeUndefined();
    expect(storeBuild).toBe(false);
  });
});

describe("failed runs", () => {
  const credits = "Connect your own API key in Models or choose Dozo credits in Billing.";
  const exhausted = "Not enough model credits. Add credits in Billing or connect your own API key.";
  const plan = "Subscribe in Billing to keep running bots.";
  const connect = "Connect a model in Settings before running bots.";

  it("off: the saved error as written", () => {
    expect(storeRunErrorDetails(credits, false)).toBe(credits);
  });

  it("on: advice to buy in Billing becomes advice to connect a model; other errors stay", () => {
    for (const text of [credits, exhausted, plan])
      expect(storeRunErrorDetails(text, true)).toBe(connect);
    expect(storeRunErrorDetails(`Run failed: ${plan}`, true)).toBe(`Run failed: ${connect}`);
    expect(storeRunErrorDetails("The model provider returned an error.", true)).toBe(
      "The model provider returned an error.",
    );
  });
});

describe("sign-in buttons", () => {
  const google: SignInProvider = { id: "google", name: "Google" };
  const apple: SignInProvider = { id: "apple", name: "Apple" };
  const organization: SignInProvider = { id: "oidc", name: "Acme SSO" };

  it("off: every provider the server offers", () => {
    expect(storeSignInProviders([google, organization], false)).toEqual([google, organization]);
  });

  it("on: a third-party sign-in only beside Sign in with Apple; organization sign-in stays", () => {
    expect(storeSignInProviders([google, apple, organization], true)).toEqual([
      google,
      apple,
      organization,
    ]);
    expect(storeSignInProviders([google, organization], true)).toEqual([organization]);
    expect(storeSignInProviders([google], true)).toEqual([]);
    expect(storeSignInProviders([], true)).toEqual([]);
  });
});

describe("Billing and the paywall behind the store gate", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("off: the screen shows", async () => {
    await act(async () => root.render(<DozoStoreGate store={false}>Billing</DozoStoreGate>));
    expect(container.textContent).toBe("Billing");
  });

  it("on: a link to it lands on the chats, and the screen never renders", async () => {
    const Screen = vi.fn(() => "Billing");
    await act(async () =>
      root.render(
        <DozoStoreGate store>
          <Screen />
        </DozoStoreGate>,
      ),
    );
    expect(container.innerHTML).toBe('<a href="/">chats</a>');
    expect(Screen).not.toHaveBeenCalled();
  });

  it("follows the build's flag when none is given", async () => {
    await act(async () => root.render(<DozoStoreGate>Billing</DozoStoreGate>));
    expect(container.textContent).toBe("Billing");
  });
});
