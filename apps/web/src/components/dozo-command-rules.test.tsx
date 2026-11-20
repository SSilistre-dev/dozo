// @vitest-environment jsdom
import type { DozoCommandRule } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), toastError: vi.fn() }));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoCommandRules: { remove: api.remove } };
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
  toast: { error: api.toastError },
}));

import type * as Query from "../lib/query";
import { dozoAlwaysAllowLabel } from "./dozo-ask-label";
import { DozoCommandRules } from "./dozo-command-rules";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const rules: DozoCommandRule[] = [
  { id: "rule-1", botId: "bot-1", botName: "Chef", words: ["npm", "test"], cwd: "~/app" },
  {
    id: "rule-2",
    botId: "bot-2",
    botName: "Scout",
    words: ["git", "commit", "-m", "wip"],
    cwd: "",
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
  const codes = [...container.querySelectorAll("code")].map((node) => node.textContent);
  expect(codes).toEqual(["npm test", "git commit -m wip"]);
  const details = [...container.querySelectorAll("p")].map((node) =>
    [...node.querySelectorAll("span")].map((span) => span.textContent),
  );
  expect(details).toEqual([["Chef", "~/app"], ["Scout"]]);
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
