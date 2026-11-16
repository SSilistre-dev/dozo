// @vitest-environment jsdom

import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createContext, useContext, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const hardware = [
    {
      id: "mac-a",
      label: "Mac A",
      kind: "unified",
      match: /Apple M9/,
      bandwidthGBps: 100,
      memoryGB: [16, 32, 64],
      source: "fixture",
    },
    {
      id: "pc-b",
      label: "PC B",
      kind: "gpu",
      match: /RTX/,
      bandwidthGBps: 200,
      memoryGB: [8, 24],
      source: "fixture",
    },
  ];
  const model = (id: string, weightsGB: number) => ({
    id,
    label: `Model ${id}`,
    tag: `tag-${id}:latest`,
    licence: "MIT",
    paramsB: weightsGB,
    weightsGB,
    kvGBPer8k: 0.1,
    thinking: false,
    source: "fixture",
    verifiedOn: "2026-01-01",
    toolCallCheckedOn: "2026-01-01",
  });
  const models = [model("m1", 2), model("m2", 4), model("m3", 6), model("m4", 8), model("m5", 10)];
  return {
    hardware,
    models,
    connect: vi.fn(),
    me: vi.fn(),
    ranked: vi.fn(),
    copy: vi.fn(async () => true),
  };
});

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), ""),
  }),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("../lib/rpc", () => {
  const read = async () => [];
  // The query helpers are built from this client, so the reads a save invalidates must exist.
  const client = Object.assign(read, {
    me: fixtures.me,
    models: { connect: fixtures.connect, list: read, credentials: read },
  });
  return {
    rpc: client,
    createSpaceRpc: () => client,
    rpcForSpace: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("./ModelSettingsOverlay", () => ({
  ModelSettingsOverlay: () => <div data-testid="upstream" />,
}));
vi.mock("../lib/dozo-local-model-catalog", () => ({
  LOCAL_HARDWARE: fixtures.hardware,
  LOCAL_MODELS: fixtures.models,
  LOCAL_RUNTIME: {
    label: "Runtime",
    baseUrl: "http://localhost:11434/v1",
    prepare: (tag: string, contextTokens: number) => ({
      command: `run ${tag} ${contextTokens}`,
      modelId: `derived-${tag}`,
    }),
  },
}));
// Tiers follow memory alone: weights x1.3 within half the memory is comfortable, within three
// quarters usable, within all of it slow. Bigger models come first inside a tier.
vi.mock("../lib/dozo-local-model-fit", () => ({
  LOCAL_MODEL_CONTEXT_TOKENS: 32768,
  matchHardware: (renderer: string | null, table: { match: RegExp }[]) =>
    (renderer && table.find((entry) => entry.match.test(renderer))) || null,
  hardwareProfile: (entry: { bandwidthGBps: number }, memoryGB: number, source: string) => ({
    kind: "unified",
    usableMemoryGB: memoryGB,
    bandwidthGBps: entry.bandwidthGBps,
    source,
  }),
  rankLocalModels: (
    profile: { usableMemoryGB: number; bandwidthGBps: number },
    catalog: { weightsGB: number }[],
  ) => {
    fixtures.ranked();
    const order = ["comfortable", "usable", "slow", "no-fit"];
    const tier = (weightsGB: number) => {
      const need = weightsGB * 1.3;
      if (need <= profile.usableMemoryGB * 0.5) return "comfortable";
      if (need <= profile.usableMemoryGB * 0.75) return "usable";
      return need <= profile.usableMemoryGB ? "slow" : "no-fit";
    };
    return catalog
      .map((model) => ({
        model,
        tier: tier(model.weightsGB),
        tokensPerSecond: profile.bandwidthGBps / model.weightsGB,
        memoryGB: model.weightsGB * 1.3,
      }))
      .sort(
        (a, b) =>
          order.indexOf(a.tier) - order.indexOf(b.tier) || b.model.weightsGB - a.model.weightsGB,
      );
  },
}));
vi.mock("@rakazo/ui-web", () => {
  const SelectContext = createContext<{
    value: string | null;
    onValueChange: (value: string) => void;
    items: { value: string; label: string }[];
  }>({ value: null, onValueChange: () => undefined, items: [] });
  return {
    Button: ({ children, ...props }: React.ComponentProps<"button">) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    Input: (props: React.ComponentProps<"input">) => <input {...props} />,
    Disclosure: ({
      summary,
      onOpenChange,
      children,
    }: {
      summary: ReactNode;
      onOpenChange?: (open: boolean) => void;
      children: ReactNode;
    }) => {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
              onOpenChange?.(!open);
            }}
          >
            {summary}
          </button>
          {/* The real one keeps its children mounted while folded. */}
          {children}
        </div>
      );
    },
    Select: ({
      value,
      onValueChange,
      items,
      children,
    }: {
      value: string | null;
      onValueChange: (value: string) => void;
      items: { value: string; label: string }[];
      children: ReactNode;
    }) => (
      <SelectContext.Provider value={{ value, onValueChange, items }}>
        {children}
      </SelectContext.Provider>
    ),
    SelectTrigger: ({ "aria-label": label }: { "aria-label"?: string }) => {
      const { value, onValueChange, items } = useContext(SelectContext);
      return (
        <select
          aria-label={label}
          value={value ?? ""}
          onChange={(event) => onValueChange(event.target.value)}
        >
          <option value="" />
          {items.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      );
    },
    SelectValue: () => null,
    SelectContent: () => null,
    SelectItem: () => null,
    useCopyText: () => [false, fixtures.copy],
  };
});

import type { HardwareEntry, LocalModelEntry } from "../lib/dozo-local-model-fit";
import { QueryUserProvider } from "../lib/query";
import { DozoLocalModels, readGpuRenderer } from "./dozo-local-models";
import { ModelSettingsOverlay } from "./dozo-model-settings";

const hardware = fixtures.hardware as unknown as HardwareEntry[];
const models = fixtures.models as unknown as LocalModelEntry[];

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixtures.connect.mockReset();
  fixtures.me.mockReset();
  fixtures.copy.mockClear();
  fixtures.ranked.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(props: React.ComponentProps<typeof DozoLocalModels> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user-a">
          <DozoLocalModels hardware={hardware} models={models} {...props} />
        </QueryUserProvider>
      </QueryClientProvider>,
    ),
  );
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === name);
const select = (label: string) =>
  container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
const rowLabels = () =>
  [...container.querySelectorAll("li > div > span:first-child")].map((n) => n.textContent);

async function open() {
  await act(async () => button("Run on this computer")?.click());
}

async function change(element: HTMLInputElement | HTMLSelectElement | null, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element?.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

it("renders nothing, detects nothing and calls nothing while collapsed", async () => {
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  await render();

  expect(container.textContent).toBe("Run on this computer");
  expect(container.querySelector("select, input")).toBeNull();
  expect(getContext).not.toHaveBeenCalled();
  expect(fixtures.connect).not.toHaveBeenCalled();

  await open();
  expect(getContext).toHaveBeenCalledOnce();
  expect(fixtures.connect).not.toHaveBeenCalled();
});

it("preselects the matched hardware and its lowest memory", async () => {
  await render({ renderer: "Apple M9 Max" });
  await open();

  expect(select("Hardware")?.value).toBe("mac-a");
  expect(select("Memory")?.value).toBe("16");
  expect(rowLabels()).toEqual(["Model m3", "Model m2", "Model m1"]);
});

it("shows only the pickers until hardware is chosen", async () => {
  await render({ renderer: "Unknown GPU" });
  await open();

  expect(select("Hardware")?.value).toBe("");
  expect(select("Memory")).toBeNull();
  expect(container.textContent).not.toContain("Nothing fits");
  expect(container.querySelector("input")).toBeNull();

  await change(select("Hardware"), "pc-b");

  expect(select("Memory")?.value).toBe("8");
  expect(container.textContent).not.toContain("Nothing fits");
  expect(rowLabels()).toEqual(["Model m1", "Model m2"]);
});

it("renders nothing at all while the catalog is empty", async () => {
  await render({ models: [] });

  expect(container.innerHTML).toBe("");
  expect(container.querySelector("button, select, input")).toBeNull();
});

it("says Nothing fits only once hardware and memory are chosen and no row qualifies", async () => {
  const [, , , , huge] = models;
  await render({ renderer: "Apple M9", models: huge ? [huge] : [] });
  await open();

  expect(container.textContent).toContain("Nothing fits");
  expect(container.querySelector("input")).toBeNull();
});

it("lists at most three rows, never slow or no-fit ones, and follows memory", async () => {
  await render({ renderer: "Apple M9" });
  await open();

  // m4 is usable at 16 GB but past the cap; m5 does not fit comfortably.
  expect(rowLabels()).toEqual(["Model m3", "Model m2", "Model m1"]);

  await change(select("Memory"), "32");
  expect(rowLabels()).toEqual(["Model m5", "Model m4", "Model m3"]);

  await change(select("Hardware"), "pc-b");
  expect(select("Memory")?.value).toBe("8");
  expect(rowLabels()).toEqual(["Model m1", "Model m2"]);
});

it("shows speed, size and copies the runtime command", async () => {
  await render({ renderer: "Apple M9" });
  await open();

  const row = container.querySelector("li");
  expect(row?.textContent).toContain("17 tok/s");
  expect(row?.textContent).toContain("6 GB");

  await act(async () => row?.querySelector<HTMLButtonElement>("button")?.click());
  expect(fixtures.copy).toHaveBeenCalledExactlyOnceWith("run tag-m3:latest 32768");
});

it("gives each row's Copy and Connect a name that carries the model", async () => {
  await render({ renderer: "Apple M9" });
  await open();

  const names = [...container.querySelectorAll("li button")].map((node) =>
    node.getAttribute("aria-label"),
  );
  expect(names).toEqual([
    "Copy Model m3",
    "Connect Model m3",
    "Copy Model m2",
    "Connect Model m2",
    "Copy Model m1",
    "Connect Model m1",
  ]);
  // The visible words stay as they were.
  expect(
    [...container.querySelectorAll("li button")].map((node) => node.textContent).slice(0, 2),
  ).toEqual(["Copy", "Connect"]);
});

it("connects with the exact payload and calls onConnected once", async () => {
  const saved = deferred<void>();
  fixtures.connect.mockReturnValue(saved.promise);
  const onConnected = vi.fn();
  await render({ renderer: "Apple M9", onConnected });
  await open();

  expect(container.querySelector("input")?.value).toBe("http://localhost:11434/v1");
  await change(container.querySelector("input"), " http://192.168.1.5:11434/v1 ");
  await act(async () =>
    container.querySelector<HTMLButtonElement>("li")?.querySelectorAll("button")[1]?.click(),
  );

  expect(fixtures.connect).toHaveBeenCalledExactlyOnceWith({
    provider: "openai-compatible",
    baseUrl: "http://192.168.1.5:11434/v1",
    modelId: "derived-tag-m3:latest",
    contextWindow: 32768,
    credentialId: null,
  });
  expect(onConnected).not.toHaveBeenCalled();
  expect(button("Connect")?.hasAttribute("disabled")).toBe(true);

  await act(async () => {
    saved.resolve();
    await flush();
  });
  await vi.waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
});

it("shows the server's message verbatim next to the row when connecting is refused", async () => {
  fixtures.connect.mockRejectedValue(new Error("That address is private and cannot be reached."));
  const onConnected = vi.fn();
  await render({ renderer: "Apple M9", onConnected });
  await open();

  await act(async () =>
    container.querySelector<HTMLButtonElement>("li")?.querySelectorAll("button")[1]?.click(),
  );

  await vi.waitFor(() =>
    expect(container.querySelector("li [role='alert']")?.textContent).toBe(
      "That address is private and cannot be reached.",
    ),
  );
  expect(onConnected).not.toHaveBeenCalled();
});

const connectButton = (index: number) =>
  container.querySelectorAll("li")[index]?.querySelectorAll("button")[1];

it("holds a connected row, names it, and leaves the other rows usable", async () => {
  fixtures.connect.mockResolvedValue(undefined);
  await render({ renderer: "Apple M9" });
  await open();

  await act(async () => connectButton(0)?.click());
  await vi.waitFor(() => expect(connectButton(0)?.textContent).toBe("Connected"));

  expect(connectButton(0)?.hasAttribute("disabled")).toBe(true);
  expect(connectButton(0)?.getAttribute("aria-label")).toBe("Connected Model m3");
  await act(async () => connectButton(0)?.click());
  expect(fixtures.connect).toHaveBeenCalledOnce();

  expect(connectButton(1)?.textContent).toBe("Connect");
  expect(connectButton(1)?.hasAttribute("disabled")).toBe(false);
  await act(async () => connectButton(1)?.click());
  await vi.waitFor(() => expect(fixtures.connect).toHaveBeenCalledTimes(2));
  expect(fixtures.connect.mock.calls[1]?.[0].modelId).toBe("derived-tag-m2:latest");
});

it("locks a connection by server and model, so another address is connectable again", async () => {
  fixtures.connect.mockResolvedValue(undefined);
  await render({ renderer: "Apple M9" });
  await open();

  await act(async () => connectButton(0)?.click());
  await vi.waitFor(() => expect(connectButton(0)?.textContent).toBe("Connected"));

  await change(container.querySelector("input"), "http://192.168.1.5:11434/v1");
  expect(connectButton(0)?.textContent).toBe("Connect");
  expect(connectButton(0)?.hasAttribute("disabled")).toBe(false);

  await change(container.querySelector("input"), "http://localhost:11434/v1");
  expect(connectButton(0)?.textContent).toBe("Connected");
  expect(connectButton(0)?.hasAttribute("disabled")).toBe(true);
});

it("ranks again only when the hardware or memory changes, not while typing the address", async () => {
  await render({ renderer: "Apple M9" });
  await open();
  const ranked = fixtures.ranked.mock.calls.length;

  await change(container.querySelector("input"), "http://192.168.1.5:11434/v1");
  await change(container.querySelector("input"), "http://192.168.1.6:11434/v1");
  expect(fixtures.ranked).toHaveBeenCalledTimes(ranked);

  await change(select("Memory"), "32");
  expect(fixtures.ranked.mock.calls.length).toBeGreaterThan(ranked);
});

it("does not mark a row connected when connecting is refused", async () => {
  fixtures.connect.mockRejectedValue(new Error("No."));
  await render({ renderer: "Apple M9" });
  await open();

  await act(async () => connectButton(0)?.click());
  await vi.waitFor(() => expect(container.querySelector("li [role='alert']")).not.toBeNull());
  expect(connectButton(0)?.textContent).toBe("Connect");
  expect(connectButton(0)?.hasAttribute("disabled")).toBe(false);
});

it("sends the scope and the default choice it was given, and nothing it was not", async () => {
  fixtures.connect.mockResolvedValue(undefined);
  await render({ renderer: "Apple M9", scope: "account", makeDefault: false });
  await open();
  await act(async () => connectButton(0)?.click());

  expect(fixtures.connect).toHaveBeenCalledExactlyOnceWith({
    provider: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    modelId: "derived-tag-m3:latest",
    contextWindow: 32768,
    credentialId: null,
    scope: "account",
    makeDefault: false,
  });
});

it("omits scope and makeDefault when it is given neither, as onboarding does", async () => {
  fixtures.connect.mockResolvedValue(undefined);
  await render({ renderer: "Apple M9" });
  await open();
  await act(async () => connectButton(0)?.click());

  const sent = fixtures.connect.mock.calls[0]?.[0];
  expect(Object.keys(sent)).not.toContain("scope");
  expect(Object.keys(sent)).not.toContain("makeDefault");
});

function fakeGl(renderer: string | null) {
  const loseContext = vi.fn();
  const gl = {
    getExtension: (name: string) => {
      if (name === "WEBGL_lose_context") return { loseContext };
      return name === "WEBGL_debug_renderer_info" && renderer !== null
        ? { UNMASKED_RENDERER_WEBGL: 37446 }
        : null;
    },
    getParameter: () => renderer,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    gl as unknown as WebGLRenderingContext,
  );
  return loseContext;
}

it("reads the renderer and releases the graphics context", () => {
  const loseContext = fakeGl("Apple M9");
  expect(readGpuRenderer()).toBe("Apple M9");
  expect(loseContext).toHaveBeenCalledOnce();
});

it("releases the graphics context when the browser will not name the renderer", () => {
  const loseContext = fakeGl(null);
  expect(readGpuRenderer()).toBeNull();
  expect(loseContext).toHaveBeenCalledOnce();
});

it("reports no renderer when the browser refuses a graphics context", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    throw new Error("no webgl");
  });
  expect(readGpuRenderer()).toBeNull();
});

async function renderSettings(props: { embedded?: boolean; scope: "account" | "space" }) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user-a">
          <ModelSettingsOverlay {...(props as React.ComponentProps<typeof ModelSettingsOverlay>)} />
        </QueryUserProvider>
      </QueryClientProvider>,
    ),
  );
}

async function connectFirstRow() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  await open();
  await change(select("Hardware"), "mac-a");
  await act(async () => connectButton(0)?.click());
  await vi.waitFor(() => expect(fixtures.connect).toHaveBeenCalledOnce());
  return fixtures.connect.mock.calls[0]?.[0];
}

it("settings keep the current main model and name the account scope", async () => {
  fixtures.me.mockResolvedValue({ defaultProvider: "openai", defaultModel: "gpt-x" });
  fixtures.connect.mockResolvedValue(undefined);
  await renderSettings({ embedded: true, scope: "account" });
  await vi.waitFor(() => expect(fixtures.me).toHaveBeenCalled());

  const sent = await connectFirstRow();
  expect(sent).toMatchObject({ scope: "account", makeDefault: false });
});

it("settings make the local model the main one when there is none", async () => {
  fixtures.me.mockResolvedValue({ defaultProvider: null, defaultModel: null });
  fixtures.connect.mockResolvedValue(undefined);
  await renderSettings({ embedded: true, scope: "account" });
  await vi.waitFor(() => expect(fixtures.me).toHaveBeenCalled());

  const sent = await connectFirstRow();
  expect(sent).toMatchObject({ scope: "account", makeDefault: true });
});

it("settings keep the main model while it is not yet known", async () => {
  fixtures.me.mockReturnValue(new Promise(() => undefined));
  fixtures.connect.mockResolvedValue(undefined);
  await renderSettings({ embedded: true, scope: "account" });

  const sent = await connectFirstRow();
  expect(sent).toMatchObject({ scope: "account", makeDefault: false });
});

it("settings show the panel only on the embedded account page", async () => {
  await renderSettings({ embedded: true, scope: "space" });
  expect(container.textContent).not.toContain("Run on this computer");
  act(() => root?.unmount());
  container.remove();
  await renderSettings({ embedded: false, scope: "account" });
  expect(container.textContent).not.toContain("Run on this computer");
});
