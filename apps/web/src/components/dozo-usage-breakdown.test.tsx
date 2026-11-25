// @vitest-environment jsdom
import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import type { DozoUsageGroup, DozoUsageGrouping, UsageSummary } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: the procedures join the app contract through a brand rule.

const api = vi.hoisted(() => ({
  groups: {} as Record<string, DozoUsageGroup[]>,
  person: false,
  hold: null as Promise<void> | null,
  csv: vi.fn(async ({ by }: { by: string }) => ({ csv: `${by}\r\n` })),
  download: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("../lib/query/query", () => ({
  useSpaceQueries: () => ({
    dozoUsage: {
      breakdown: {
        queryOptions: ({ input }: { input: { by: DozoUsageGrouping } }) => ({
          queryKey: ["breakdown", input.by],
          queryFn: async () => {
            if (input.by === "day") await api.hold;
            return api.groups[input.by] ?? [];
          },
        }),
      },
      scope: {
        queryOptions: () => ({
          queryKey: ["scope"],
          queryFn: async () => ({ person: api.person }),
        }),
      },
      csv: { call: api.csv },
    },
  }),
}));
vi.mock("../lib/pages/artifact-open", () => ({ downloadArtifactBytes: api.download }));
vi.mock("../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("./IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactElement }) => children,
}));
vi.mock("../pages/settings/AccountSettingsOverlay", () => ({
  UsageSettingsPanel: ({ usage }: { usage?: UsageSummary | null }) => (
    <div data-testid="upstream-usage">{usage?.models?.length ?? "none"}</div>
  ),
}));

import { DozoUsageSettingsPanel } from "./dozo-usage-breakdown";

function group(more: Partial<DozoUsageGroup>): DozoUsageGroup {
  return {
    key: "k",
    name: "small",
    detail: "openai",
    state: "live",
    modelCalls: 3,
    inputTokens: 1200,
    outputTokens: 300,
    totalTokens: 1500,
    costUsd: 0.42,
    ...more,
  };
}

const summary: UsageSummary = {
  inputTokens: 1200,
  outputTokens: 300,
  totalTokens: 1500,
  costUsd: 0.42,
  modelCalls: 3,
  runs: 1,
  models: [
    {
      provider: "openai",
      model: "small",
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      costUsd: 0.42,
      modelCalls: 3,
    },
  ],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  api.groups = {
    model: [group({})],
    bot: [
      group({ key: "b1", name: "Chef", detail: null }),
      group({ key: "b2", name: "Old helper", detail: null, state: "deleted", costUsd: 0.001 }),
      group({ key: "", name: null, detail: null, state: "none", costUsd: null }),
    ],
    routine: [
      group({ key: "r1", name: "Morning digest", detail: "Chef" }),
      group({ key: "unknown", name: null, detail: null, state: "unknown" }),
      group({ key: "none", name: null, detail: null, state: "none" }),
    ],
  };
  api.groups.day = [
    group({ key: "2026-11-21", name: "2026-11-21", detail: null, costUsd: 2 }),
    group({ key: "2026-11-20", name: "2026-11-20", detail: null, costUsd: 1 }),
  ];
  api.groups.person = [
    group({ key: "u1", name: "Ada", detail: "ada@example.test", costUsd: 3 }),
    group({ key: "u2", name: null, detail: null, state: "unknown", costUsd: 1 }),
  ];
  api.person = false;
  api.hold = null;
  api.csv.mockClear();
  api.download.mockClear();
  api.toastError.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function show(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}

const rows = () =>
  [...host.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent),
  );

function pick(label: string) {
  const item = [...host.querySelectorAll("[data-testid=usage-breakdown] button")].find(
    (button) => button.textContent === label,
  ) as HTMLButtonElement;
  act(() => item.click());
}

it("keeps upstream's totals, drops its per-model table and groups by model first", async () => {
  await show(<DozoUsageSettingsPanel usage={summary} />);
  expect(host.querySelector("[data-testid=upstream-usage]")?.textContent).toBe("0");
  await vi.waitFor(() => expect(rows()).toEqual([["smallopenai", "3", "1,200", "300", "$0.42"]]));
});

it("shows nothing more before there is usage", async () => {
  await show(<DozoUsageSettingsPanel usage={{ ...summary, models: [] }} />);
  expect(host.querySelector("[data-testid=usage-breakdown]")).toBeNull();
  await show(<DozoUsageSettingsPanel usage={null} />);
  expect(host.querySelector("[data-testid=upstream-usage]")?.textContent).toBe("none");
});

it("groups by bot, naming deleted bots and spend without one", async () => {
  await show(<DozoUsageSettingsPanel usage={summary} />);
  pick("Bot");
  await vi.waitFor(() => expect(host.querySelector("thead")?.textContent).toContain("Bot"));
  await vi.waitFor(() =>
    expect(rows()).toEqual([
      ["Chef", "3", "1,200", "300", "$0.42"],
      ["Old helperDeleted", "3", "1,200", "300", "<$0.01"],
      ["No bot", "3", "1,200", "300", "—"],
    ]),
  );
});

it("groups by routine, with each routine's bot, and what it cannot tell", async () => {
  await show(<DozoUsageSettingsPanel usage={summary} />);
  pick("Routine");
  await vi.waitFor(() =>
    expect(rows().map((row) => row[0])).toEqual(["Morning digestChef", "Unknown", "No routine"]),
  );
});

const buttons = () =>
  [...host.querySelectorAll("[data-testid=usage-breakdown] button")].map((b) => b.textContent);

it("groups by day, newest first, with a bar scaled to the costliest day", async () => {
  await show(<DozoUsageSettingsPanel usage={summary} />);
  pick("Day");
  await vi.waitFor(() =>
    expect(rows().map((row) => [row[0], row[4]])).toEqual([
      ["Sat, Nov 21", "$2.00"],
      ["Fri, Nov 20", "$1.00"],
    ]),
  );
  const bars = [...host.querySelectorAll<HTMLElement>("tbody [aria-hidden]")];
  expect(bars.map((bar) => bar.style.width)).toEqual(["100%", "50%"]);
});

it("draws no bars over the previous grouping's rows while the days load", async () => {
  const days = deferred();
  api.hold = days.promise;
  await show(<DozoUsageSettingsPanel usage={summary} />);
  await vi.waitFor(() => expect(rows()).toHaveLength(1));
  pick("Day");
  // Still the model rows, kept while the days arrive: no bar yet.
  await vi.waitFor(() => expect(host.querySelector("thead")?.textContent).toContain("Day"));
  expect(rows()).toHaveLength(1);
  expect(host.querySelectorAll("tbody [aria-hidden]")).toHaveLength(0);
  await act(async () => days.resolve());
  await vi.waitFor(() => expect(host.querySelectorAll("tbody [aria-hidden]")).toHaveLength(2));
});

it("offers person only when the server says the caller may, and lists everyone", async () => {
  await show(<DozoUsageSettingsPanel usage={summary} />);
  await vi.waitFor(() => expect(rows()).toHaveLength(1));
  expect(buttons()).not.toContain("Person");
  act(() => root.unmount());
  root = createRoot(host);
  api.person = true;
  await show(<DozoUsageSettingsPanel usage={summary} />);
  await vi.waitFor(() => expect(buttons()).toContain("Person"));
  pick("Person");
  await vi.waitFor(() =>
    expect(rows().map((row) => row[0])).toEqual(["Adaada@example.test", "Unknown"]),
  );
  await act(async () =>
    (host.querySelector("[aria-label='Download CSV']") as HTMLButtonElement).click(),
  );
  expect(api.csv).toHaveBeenCalledWith({ by: "person" });
});

it("downloads the grouping shown as the server's CSV", async () => {
  await show(<DozoUsageSettingsPanel usage={summary} />);
  pick("Routine");
  await act(async () =>
    (host.querySelector("[aria-label='Download CSV']") as HTMLButtonElement).click(),
  );
  expect(api.csv).toHaveBeenCalledWith({ by: "routine" });
  const [name, type, bytes] = api.download.mock.calls[0]!;
  expect(name).toMatch(/^usage-routine-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(type).toBe("text/csv");
  expect(new TextDecoder().decode(bytes)).toBe("routine\r\n");
});

it("names the CSV with the person's own day", async () => {
  const zone = process.env.TZ;
  process.env.TZ = "Europe/Istanbul";
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-20T21:30:00Z") });
  try {
    await show(<DozoUsageSettingsPanel usage={summary} />);
    await act(async () =>
      (host.querySelector("[aria-label='Download CSV']") as HTMLButtonElement).click(),
    );
    // Half past midnight in Istanbul is still the day before in UTC.
    expect(api.download.mock.calls[0]?.[0]).toBe("usage-model-2026-11-21.csv");
  } finally {
    vi.useRealTimers();
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

it("says so when the download fails", async () => {
  const failure = new Error("offline");
  api.csv.mockRejectedValueOnce(failure);
  await show(<DozoUsageSettingsPanel usage={summary} />);
  await act(async () =>
    (host.querySelector("[aria-label='Download CSV']") as HTMLButtonElement).click(),
  );
  expect(api.download).not.toHaveBeenCalled();
  expect(api.toastError).toHaveBeenCalledWith("Could not export", failure);
});

it("speaks Turkish with the catalog the build ships", async () => {
  i18n.load("tr", tr as Messages);
  i18n.activate("tr");
  await show(<DozoUsageSettingsPanel usage={summary} />);
  expect(host.querySelector("[aria-label=Grupla]")).not.toBeNull();
  pick("Rutin");
  await vi.waitFor(() =>
    expect(rows().map((row) => row[0])).toEqual(["Morning digestChef", "Bilinmiyor", "Rutin dışı"]),
  );
  pick("Bot");
  await vi.waitFor(() => expect(rows().map((row) => row[0])).toContain("Bot dışı"));
  expect(host.querySelector("[aria-label='CSV indir']")).not.toBeNull();
});
