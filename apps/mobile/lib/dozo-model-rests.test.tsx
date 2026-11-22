// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the rests procedure exists once the brand rules apply.

const api = vi.hoisted(() => ({ rpc: vi.fn(), rosterReads: [] as (() => unknown)[] }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("./i18n", () => ({ dateLocaleForUi: () => "en-GB", useUiLocale: () => "en" }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: {},
  }),
  rpc: api.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./roster-signals", () => ({
  useRosterSignals: (read: () => unknown, enabled: boolean) => {
    if (enabled) api.rosterReads.push(read);
  },
}));

import { useDozoRestNote } from "./dozo-model-rests";
import { queryClient } from "./query";

let root: Root;
let container: HTMLDivElement;
let note: ReturnType<typeof useDozoRestNote> = () => undefined;

function Probe() {
  note = useDozoRestNote();
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  api.rosterReads = [];
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("useDozoRestNote", () => {
  it("says when a resting model or connection opens again, and nothing otherwise", async () => {
    const soon = new Date(Date.now() + 60 * 60_000).toISOString();
    const later = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
    api.rpc.mockImplementation(async () => ({
      rests: [
        { credentialId: "a", modelId: "m", opensAt: soon },
        { credentialId: "b", modelId: "", opensAt: later },
        { credentialId: "c", modelId: "m", opensAt: "2020-01-01T00:00:00.000Z" },
      ],
    }));
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(note("a", "m")).toMatch(/^Opens at .+/));
    expect(api.rpc).toHaveBeenCalledWith("dozoModelPool/get", undefined, expect.anything());
    // The whole connection rests, so every model on it; days away names the day.
    expect(note("b", "any")).toMatch(/^Opens at .+/);
    expect(note("b", "any")).not.toBe(note("a", "m"));
    expect(note("a", "other")).toBeUndefined();
    expect(note("c", "m")).toBeUndefined();
    expect(note(undefined, "m")).toBeUndefined();
    // A new rest's roster signal reads them again.
    expect(api.rosterReads.length).toBeGreaterThan(0);
    await act(async () => api.rosterReads.at(-1)!());
    await vi.waitFor(() => expect(api.rpc).toHaveBeenCalledTimes(2));
  });

  it("says nothing before the rests are read", async () => {
    api.rpc.mockReturnValue(new Promise(() => undefined));
    await act(async () => root.render(<Probe />));
    expect(note("a", "m")).toBeUndefined();
  });
});
