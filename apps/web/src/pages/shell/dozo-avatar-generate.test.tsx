// @vitest-environment jsdom
import { deferred, flush } from "@rakazo/core/test-async";
import { Tabs, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ status: vi.fn(), generate: vi.fn() }));

vi.mock("../../lib/rpc", () => {
  const rpc = { dozoAvatarGenerate: { generate: api.generate } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoAvatarGenerate: {
      status: {
        queryOptions: () => ({ queryKey: ["avatar-generate-status"], queryFn: api.status }),
      },
    },
  }),
}));
vi.mock("../../lib/dozo-error-text", () => ({
  errorText: (_error: unknown, fallback = "Something went wrong. Try again.") => fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import type * as Query from "../../lib/query";
import { DozoAvatarGeneratePanel, DozoAvatarGenerateTab } from "./dozo-avatar-generate";

const IMAGE = "data:image/webp;base64,AAAA";
const used = vi.fn<(image: string) => void>();
let client: QueryClient;
let container: HTMLDivElement;
let root: Root;

function Harness() {
  const [tab, setTab] = useState("generate");
  return (
    <QueryClientProvider client={client}>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="bot">Bot</TabsTrigger>
          <DozoAvatarGenerateTab />
        </TabsList>
        <DozoAvatarGeneratePanel onUse={used} />
      </Tabs>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  used.mockClear();
  api.status.mockReset();
  api.generate.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function open(status: { available: boolean; reason: string | null }) {
  api.status.mockResolvedValue(status);
  await act(async () => root.render(<Harness />));
  await act(flush);
}
function button(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === name && node.getAttribute("role") !== "tab",
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
const hasButton = (name: string) =>
  [...document.querySelectorAll("button")].some(
    (node) => node.textContent === name && node.getAttribute("role") !== "tab",
  );
async function describe_(text: string) {
  const field = document.querySelector<HTMLTextAreaElement>("textarea");
  if (!field) throw new Error("Missing field");
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function tab(name: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (node) => node.textContent === name,
  );
  if (!found) throw new Error(`Missing tab ${name}`);
  return found;
}
async function press(name: string) {
  await act(async () => button(name).click());
}
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? null;

describe("drawing an avatar from a description", () => {
  it.each([
    ["no image service", { available: false, reason: "unavailable" }],
    ["a plan without it", { available: false, reason: "plan" }],
    ["today's allowance used", { available: false, reason: "limit" }],
  ])("offers nothing with %s", async (_name, status) => {
    await open(status);
    expect(document.body.textContent).not.toContain("Generate");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("starts with only the description and Generate, which waits for words", async () => {
    await open({ available: true, reason: null });
    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      "Bot",
      "Generate",
    ]);
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
    expect(button("Generate").getAttribute("data-testid")).toBe("avatar-generate-submit");
    expect(hasButton("Use")).toBe(false);
    expect(button("Generate").disabled).toBe(true);
  });

  it("shows the failure and changes nothing when the service fails", async () => {
    await open({ available: true, reason: null });
    api.generate.mockRejectedValue(
      Object.assign(new Error("down"), { code: "avatar_generate_failed" }),
    );
    await describe_("a fox");
    await press("Generate");
    await act(flush);
    expect(alertText()).toBe("Something went wrong. Try again.");
    expect(hasButton("Use")).toBe(false);
    expect(used).not.toHaveBeenCalled();
  });

  it("shows the failure for a picture that is not a usable image", async () => {
    await open({ available: true, reason: null });
    api.generate.mockRejectedValue(Object.assign(new Error("bad"), { code: "avatar_image" }));
    await describe_("a fox");
    await press("Generate");
    await act(flush);
    expect(alertText()).not.toBeNull();
    expect(used).not.toHaveBeenCalled();
  });

  it("shows the refusal when one is already being drawn elsewhere", async () => {
    await open({ available: true, reason: null });
    api.generate.mockRejectedValue(
      Object.assign(new Error("busy"), { code: "avatar_generate_busy" }),
    );
    await describe_("a fox");
    await press("Generate");
    await act(flush);
    expect(alertText()).toBe("Something went wrong. Try again.");
    expect(button("Generate").disabled).toBe(false);
  });

  it("shows the refusal and reads the status again when the day's allowance is used up", async () => {
    await open({ available: true, reason: null });
    api.generate.mockRejectedValue(
      Object.assign(new Error("limit"), { code: "avatar_generate_limit" }),
    );
    api.status.mockResolvedValue({ available: false, reason: "limit" });
    await describe_("a fox");
    await press("Generate");
    await act(flush);
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(alertText()).toBe("Something went wrong. Try again.");
    expect(document.querySelector('[role="tab"][aria-selected]')).not.toBeNull();
    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      "Bot",
    ]);
  });

  it("keeps the last picture usable but offers no more once the allowance is spent", async () => {
    await open({ available: true, reason: null });
    api.generate.mockResolvedValue({ image: IMAGE });
    api.status.mockResolvedValue({ available: false, reason: "limit" });
    await describe_("a fox");
    await press("Generate");
    await act(flush);
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(hasButton("Use")).toBe(true);
    expect(hasButton("Try again")).toBe(false);
    await press("Use");
    expect(used).toHaveBeenCalledWith(IMAGE);
  });

  it("sends one request for two presses and ignores nothing it needs", async () => {
    await open({ available: true, reason: null });
    const answer = deferred<{ image: string }>();
    api.generate.mockReturnValue(answer.promise);
    await describe_("a fox");
    await act(async () => {
      button("Generate").click();
      button("Generate").click();
    });
    expect(api.generate).toHaveBeenCalledTimes(1);
    expect(api.generate.mock.calls[0]?.[0]).toEqual({ prompt: "a fox" });
    expect(button("Generate").disabled).toBe(true);
    await act(async () => answer.resolve({ image: IMAGE }));
    await act(flush);
    expect(hasButton("Use")).toBe(true);
  });

  it("drops the request and its late answer when the tab is left", async () => {
    await open({ available: true, reason: null });
    const answer = deferred<{ image: string }>();
    api.generate.mockReturnValue(answer.promise);
    await describe_("a fox");
    await press("Generate");
    const signal = api.generate.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => tab("Bot").click());
    expect(signal.aborted).toBe(true);
    await act(async () => answer.resolve({ image: IMAGE }));
    await act(flush);
    expect(hasButton("Use")).toBe(false);
    expect(used).not.toHaveBeenCalled();
  });

  it("drops the request when the studio closes", async () => {
    await open({ available: true, reason: null });
    api.generate.mockReturnValue(deferred<{ image: string }>().promise);
    await describe_("a fox");
    await press("Generate");
    const signal = api.generate.mock.calls[0]?.[1]?.signal as AbortSignal;
    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
    expect(used).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("uses the picture exactly once, and draws again from the same description", async () => {
    await open({ available: true, reason: null });
    api.generate.mockResolvedValueOnce({ image: IMAGE });
    await describe_("a fox");
    await press("Generate");
    await act(flush);
    expect(document.querySelector("img")?.getAttribute("src")).toBe(IMAGE);

    const second = "data:image/webp;base64,BBBB";
    api.generate.mockResolvedValueOnce({ image: second });
    await press("Try again");
    await act(flush);
    expect(api.generate).toHaveBeenCalledTimes(2);
    expect(api.generate.mock.calls[1]?.[0]).toEqual({ prompt: "a fox" });
    expect(used).not.toHaveBeenCalled();

    await press("Use");
    expect(used).toHaveBeenCalledTimes(1);
    expect(used).toHaveBeenCalledWith(second);
  });
});
