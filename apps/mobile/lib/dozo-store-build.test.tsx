// @vitest-environment jsdom
import type { PlanLimitNotice, SignInProvider } from "@rakazo/contracts";
import { planLimitCopy } from "@rakazo/i18n/run-error";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the plan-limit copy exists once the brand rules apply.

vi.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => <a href={href}>chats</a>,
}));

import { DozoStoreGate } from "../components/dozo-store-gate";
import {
  mobilePlanLimitCopy,
  storeBuild,
  storePlanLimitCopy,
  storeComputerHoursOut,
  storePlanLimitNotice,
  storeRunErrorDetails,
  storeSignInProviders,
} from "./dozo-store-build";

describe("the store build flag", () => {
  it("is off unless the bundle was made with EXPO_PUBLIC_DOZO_STORE_BUILD=1", () => {
    expect(process.env.EXPO_PUBLIC_DOZO_STORE_BUILD).toBeUndefined();
    expect(storeBuild).toBe(false);
  });
});

describe("plan-limit sentences", () => {
  const copy = planLimitCopy();
  // The sentences only: `upgradeTo` is a new function on every call.
  const sentences = (value: object) => JSON.parse(JSON.stringify(value));

  it("off: every sentence as written, the upgrade ones included", () => {
    expect(storePlanLimitCopy(copy, false)).toBe(copy);
    expect(sentences(mobilePlanLimitCopy(false))).toEqual(sentences(copy));
  });

  it("on: no sentence points at a purchase; the limit and the way out by deleting stay", () => {
    const store = storePlanLimitCopy(copy, true);
    expect(sentences(mobilePlanLimitCopy(true))).toEqual(sentences(store));
    expect(store.computerNotInPlanAskOwner).toBe("Your plan doesn't include a computer.");
    for (const key of ["sharedSpaceFull", "sharedSpaceFullUpgrade", "sharedSpaceFullAskOwner"])
      expect(store[key as keyof typeof store]).toBe(
        "Shared space is full. Delete files to make room.",
      );
    const texts = Object.values(store).filter((value) => typeof value === "string");
    const offered = new Set(["Upgrade", copy.planNotOffered]);
    for (const sentence of texts.filter((text) => !offered.has(text)))
      expect(sentence).not.toMatch(/upgrade|plan\./i);
  });
});

describe("plan-limit notices", () => {
  const upgrade: PlanLimitNotice = {
    code: "computer_not_in_plan" as PlanLimitNotice["code"],
    text: "Your plan doesn't include a computer.",
    action: { kind: "upgrade", label: "Upgrade", startsPaidPlan: true },
  };
  const retry: PlanLimitNotice = {
    code: "computers_busy" as PlanLimitNotice["code"],
    text: "All computers are busy. Try again shortly.",
    action: { kind: "retry", label: "Try again" },
  };

  it("off: the upgrade stays", () => {
    expect(storePlanLimitNotice(upgrade, false)).toBe(upgrade);
  });

  it("on: the sentence without its upgrade; a retry and no notice stay as they are", () => {
    expect(storePlanLimitNotice(upgrade, true)).toEqual({ ...upgrade, action: null });
    expect(storePlanLimitNotice(retry, true)).toBe(retry);
    expect(storePlanLimitNotice(null, true)).toBeNull();
  });
});

describe("computer hours used up", () => {
  const copy = { summary: "This month's computer hours are used up.", action: "Upgrade" };

  it("off: the sentence and its action", () => {
    expect(storeComputerHoursOut(copy, false)).toBe(copy);
  });

  it("on: the same sentence with no action to a plan", () => {
    expect(storeComputerHoursOut(copy, true)).toEqual({ summary: copy.summary, action: null });
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
