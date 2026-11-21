// @vitest-environment jsdom
import type { DozoCommandRule } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoCommandRules: { remove: api.remove, update: api.update } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoCommandRules: {
      list: {
        key: () => ["command-rules"],
        queryOptions: () => ({ queryKey: ["command-rules"], queryFn: () => api.list() }),
      },
    },
  }),
}));
vi.mock("../lib/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  toast: { error: api.toastError },
}));

import type * as Query from "../lib/query";
import { dozoAlwaysAllowLabel } from "./dozo-ask-label";
import { DozoCommandRules } from "./dozo-command-rules";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const rules: DozoCommandRule[] = [
  {
    id: "rule-1",
    botId: "bot-1",
    botName: "Chef",
    words: ["npm", "test"],
    cwd: "~/app",
    effect: "allow",
    computer: "user",
  },
  {
    id: "rule-2",
    botId: "bot-2",
    botName: "Scout",
    words: ["git", "commit", "-m", "wip"],
    cwd: "",
    effect: "allow",
    computer: "user",
  },
];

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DozoCommandRules />
      </QueryClientProvider>,
    );
  });
}

const remove = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${label}"]`);
const effect = (label: string) =>
  container.querySelector<HTMLSelectElement>(`select[aria-label="What ${label} does"]`);
const choices = (label: string) => [...(effect(label)?.options ?? [])].map((o) => o.value);
const codes = () => [...container.querySelectorAll("code")].map((node) => node.textContent);
const details = () =>
  [...container.querySelectorAll("p")].map((node) =>
    [...node.querySelectorAll("span")].map((span) => span.textContent),
  );

async function choose(label: string, value: string) {
  await act(async () => {
    const node = effect(label)!;
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows nothing until a command is always allowed", async () => {
  api.list.mockResolvedValue([]);
  await render();
  await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});

it("lists each command with its bot and folder", async () => {
  api.list.mockResolvedValue(rules);
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Commands"));
  expect(codes()).toEqual(["npm test", "git commit -m wip"]);
  expect(details()).toEqual([["Chef", "~/app"], ["Scout"]]);
  expect(effect("npm test")?.value).toBe("allow");
  expect(choices("npm test")).toEqual(["allow", "allow_prefix", "block"]);
});

it("marks a rule that allows arguments, and names the bot's computer", async () => {
  api.list.mockResolvedValue([
    { ...rules[0], effect: "allow_prefix", computer: "hosted" },
    { ...rules[1], cwd: "~/repo", effect: "block", computer: "hosted" },
  ]);
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Commands"));
  expect(codes()).toEqual(["npm test …", "git commit -m wip"]);
  // A block applies in every folder and on every computer.
  expect(details()).toEqual([["Chef", "~/app", "Bot computer"], ["Scout"]]);
  expect(effect("npm test")?.value).toBe("allow_prefix");
  expect(effect("git commit -m wip")?.value).toBe("block");
});

it("offers arguments only where a prefix rule is allowed, or already saved", async () => {
  api.list.mockResolvedValue([
    { ...rules[0], id: "a", words: ["bash", "-c"] },
    { ...rules[0], id: "b", words: ["make"] },
    { ...rules[0], id: "c", words: ["sh", "-c"], effect: "allow_prefix" },
  ]);
  await render();
  await vi.waitFor(() => expect(effect("bash -c")).not.toBeNull());
  expect(choices("bash -c")).toEqual(["allow", "block"]);
  expect(choices("make")).toEqual(["allow", "block"]);
  expect(choices("sh -c")).toEqual(["allow", "allow_prefix", "block"]);
});

it("changes what a rule does and reads the list again", async () => {
  api.list.mockResolvedValue(rules);
  api.update.mockImplementation(async ({ effect }) => {
    api.list.mockResolvedValue([{ ...rules[0], effect }, rules[1]]);
    return { ok: true };
  });
  await render();
  await vi.waitFor(() => expect(effect("npm test")).not.toBeNull());
  await choose("npm test", "block");
  expect(api.update).toHaveBeenCalledWith({ id: "rule-1", effect: "block" });
  await vi.waitFor(() => expect(effect("npm test")?.value).toBe("block"));
  expect(details()[0]).toEqual(["Chef"]);
});

it("says so when a change fails, and shows what the rule does again", async () => {
  api.list.mockResolvedValue(rules);
  api.update.mockRejectedValue(new Error("down"));
  await render();
  await vi.waitFor(() => expect(effect("npm test")).not.toBeNull());
  await choose("npm test", "allow_prefix");
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Could not update rule"));
  await vi.waitFor(() => expect(effect("npm test")?.value).toBe("allow"));
  expect(codes()[0]).toBe("npm test");
});

it("removes a rule and reads the list again", async () => {
  api.list.mockResolvedValue(rules);
  api.remove.mockImplementation(async () => {
    api.list.mockResolvedValue(rules.slice(1));
    return { ok: true };
  });
  await render();
  await vi.waitFor(() => expect(remove("npm test")).not.toBeNull());
  await act(async () => remove("npm test")?.click());
  expect(api.remove).toHaveBeenCalledWith({ id: "rule-1" });
  await vi.waitFor(() => expect(remove("npm test")).toBeNull());
  expect(remove("git commit -m wip")).not.toBeNull();
});

it("says so when a removal fails, and keeps the rule", async () => {
  api.list.mockResolvedValue(rules);
  api.remove.mockRejectedValue(new Error("down"));
  await render();
  await vi.waitFor(() => expect(remove("npm test")).not.toBeNull());
  await act(async () => remove("npm test")?.click());
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Could not remove rule"));
  expect(remove("npm test")).not.toBeNull();
});

it("names the card's Always allow after the command only when the server says so", () => {
  expect(dozoAlwaysAllowLabel("Always allow this command")).toBe("Always allow this command");
  expect(dozoAlwaysAllowLabel("Always allow this tool")).toBeUndefined();
});
