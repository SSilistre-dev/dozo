import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import type { BillingStatus } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openPlanUpgrade,
  showPlanLimitAlert,
  usePlanLimitNotice,
  webBillingUrl,
} from "./dozo-plan-limit";

// Runs on the branded tree (`make qa`): the table is exported once the brand rules are applied.

const native = vi.hoisted(() => ({
  alert: vi.fn(),
  openURL: vi.fn(async (_url: string) => true),
  push: vi.fn(),
  billing: null as Partial<BillingStatus> | null,
  fetchFails: false,
  queryEnabled: [] as boolean[],
}));

vi.mock("react-native", () => ({
  Alert: { alert: native.alert },
  Linking: { openURL: native.openURL },
}));
vi.mock("expo-router", () => ({ router: { push: native.push } }));
vi.mock("./api", () => ({ currentApiBase: () => "https://dozo.example.invalid" }));
vi.mock("./query", () => ({
  rpcQuery: (proc: string) => ({ queryKey: [proc] }),
  queryClient: {
    fetchQuery: async () => {
      if (native.fetchFails) throw new Error("offline");
      return native.billing;
    },
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ enabled }: { enabled: boolean }) => {
    native.queryEnabled.push(enabled);
    return { data: enabled ? native.billing : undefined };
  },
}));

const offers = [
  {
    tier: "pro" as const,
    name: "Premium",
    monthlyPriceCents: 4900,
    annualPriceCents: null,
    computerSize: "large" as const,
    computerHours: 100,
  },
  {
    tier: "max" as const,
    name: "Premium Plus",
    monthlyPriceCents: 9900,
    annualPriceCents: null,
    computerSize: "large" as const,
    computerHours: 200,
  },
];
const free = {
  canManage: true,
  byokTier: "standard",
  byokTiers: offers,
  funding: "byok",
  state: "none",
} satisfies Partial<BillingStatus>;

beforeEach(() => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  native.billing = free;
  native.fetchFails = false;
  native.queryEnabled = [];
});
afterEach(() => vi.clearAllMocks());

type Button = { text: string; onPress?: () => void };
const lastAlert = () => native.alert.mock.calls.at(-1) as [string, string, Button[]];

it("points at the web app's Billing on the API's origin", () => {
  expect(webBillingUrl("https://dozo.example.invalid/")).toBe(
    "https://dozo.example.invalid/?settings=billing",
  );
});

describe("openPlanUpgrade", () => {
  it("opens the web Billing in the system browser for a first paid plan", () => {
    const inApp = vi.fn();
    openPlanUpgrade({ kind: "upgrade", label: "Upgrade", startsPaidPlan: true }, inApp);
    expect(native.openURL).toHaveBeenCalledWith("https://dozo.example.invalid/?settings=billing");
    expect(inApp).not.toHaveBeenCalled();
  });

  it("falls back to the app's Billing when the browser cannot open", async () => {
    const inApp = vi.fn();
    openPlanUpgrade(
      { kind: "upgrade", label: "Upgrade", startsPaidPlan: true },
      inApp,
      async () => {
        throw new Error("no browser");
      },
    );
    await flush();
    expect(inApp).toHaveBeenCalledOnce();
  });

  it("falls back to the app's Billing when opening the browser throws at once", async () => {
    const inApp = vi.fn();
    openPlanUpgrade({ kind: "upgrade", label: "Upgrade", startsPaidPlan: true }, inApp, () => {
      throw new Error("no browser");
    });
    await flush();
    expect(inApp).toHaveBeenCalledOnce();
  });

  it("stays in the app for a change between paid plans and without an action", () => {
    const inApp = vi.fn();
    openPlanUpgrade({ kind: "upgrade", label: "Upgrade", startsPaidPlan: false }, inApp);
    openPlanUpgrade(null, inApp);
    expect(inApp).toHaveBeenCalledTimes(2);
    expect(native.openURL).not.toHaveBeenCalled();
  });
});

describe("usePlanLimitNotice", () => {
  it("reads the billing status for computer hours and tells Free its plan has none", () => {
    expect(usePlanLimitNotice("No computer hours left.")).toMatchObject({
      code: "computer_not_in_plan",
      action: { kind: "upgrade", startsPaidPlan: true },
    });
    expect(native.queryEnabled).toEqual([true]);
  });

  it("needs no billing status for a busy host, and gives nothing for other failures", () => {
    i18n.loadAndActivate({ locale: "tr", messages: tr as Messages });
    expect(usePlanLimitNotice({ code: "COMPUTERS_BUSY" })).toMatchObject({
      text: "Tüm bilgisayarlar meşgul. Birazdan tekrar deneyin.",
      action: { kind: "retry", label: "Tekrar dene" },
    });
    expect(usePlanLimitNotice("Something else")).toBeNull();
    expect(native.queryEnabled).toEqual([false, false]);
  });
});

describe("showPlanLimitAlert", () => {
  const full = "Shared space is full. Delete files or change the plan.";

  it("leaves other failures to the caller", () => {
    expect(showPlanLimitAlert("Failed", "Something else")).toBe(false);
    expect(showPlanLimitAlert("Failed", { code: "space_limit_reached" })).toBe(false);
    expect(native.alert).not.toHaveBeenCalled();
  });

  it("the owner: the sentence and Upgrade, which opens Billing", async () => {
    native.billing = { ...free, byokTier: "pro", state: "active" };
    expect(showPlanLimitAlert("Failed", full)).toBe(true);
    await flush();
    const [title, message, buttons] = lastAlert();
    expect(title).toBe("Failed");
    expect(message).toBe("Shared space is full. Delete files or upgrade.");
    expect(buttons.map((button) => button.text)).toEqual(["Not Now", "Upgrade"]);
    buttons[1]?.onPress?.();
    expect(native.push).toHaveBeenCalledWith("/billing");
  });

  it("a member who cannot manage billing: ask the owner, no Upgrade", async () => {
    native.billing = { ...free, canManage: false };
    showPlanLimitAlert("Failed", full);
    await flush();
    const [, message, buttons] = lastAlert();
    expect(message).toBe("Shared space is full. Delete files or ask the owner to upgrade.");
    expect(buttons.map((button) => button.text)).toEqual(["Close"]);
  });

  it("without the billing status: the neutral sentence, no Upgrade", async () => {
    native.fetchFails = true;
    showPlanLimitAlert("Failed", full);
    await flush();
    const [, message, buttons] = lastAlert();
    expect(message).toBe(full);
    expect(buttons).toHaveLength(1);
  });

  it("computer hours without a status: no hours left, in the UI's language, no Upgrade", async () => {
    native.fetchFails = true;
    i18n.loadAndActivate({ locale: "tr", messages: tr as Messages });
    showPlanLimitAlert("Failed", new Error("No computer hours left."));
    await flush();
    expect(lastAlert()[1]).toBe("Bilgisayar saatiniz kalmadı.");
    expect(lastAlert()[2]).toHaveLength(1);
  });

  it("computer hours on a trial keep the failure's own text, which upstream words", async () => {
    native.billing = { ...free, state: "trialing" };
    showPlanLimitAlert("Failed", "No computer hours left.");
    await flush();
    expect(lastAlert()[1]).toBe("No computer hours left.");
    showPlanLimitAlert("Failed", new Error("No computer hours left."));
    await flush();
    expect(lastAlert()[1]).toBeUndefined();
  });
});
