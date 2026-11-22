// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { act, cloneElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  credentials: vi.fn(),
  forRole: vi.fn(),
  rests: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/rpc", () => {
  const rpc = {
    dozoBotModelBackups: { get: api.get, set: api.set },
    models: { credentials: api.credentials, forRole: api.forRole },
    dozoModelPool: { rests: api.rests },
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => "space-1",
  };
});
vi.mock("../../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en-GB" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: Record<string, unknown>) => <button type="button" {...props} />,
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" data-item disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
}));
// The picker lists its options as buttons; picking one is a click.
vi.mock("../model-settings/role-model-picker", () => ({
  RoleModelPicker: ({
    trigger,
    label,
    options,
    onPick,
    onConnect,
    disabled,
  }: {
    trigger: ReactElement;
    label: string;
    options: Array<{ id: string; credentialId?: string }>;
    onPick: (option: unknown) => void;
    onConnect: (provider: unknown) => void;
    disabled?: boolean;
  }) => (
    <div data-picker={label}>
      {trigger}
      <button type="button" data-none={label} onClick={() => onPick(null)} />
      <button type="button" data-connect={label} onClick={() => onConnect({ id: "provider-c" })} />
      {options.map((option) => (
        <button
          key={`${option.id}:${option.credentialId ?? ""}`}
          type="button"
          data-pick={`${label}|${option.id}`}
          disabled={disabled}
          onClick={() => onPick(option)}
        >
          {option.id}
        </button>
      ))}
    </div>
  ),
}));

import { QueryUserProvider } from "../../lib/query";
import { DozoBotBackups } from "./dozo-bot-backups";
import { dozoBotBackupsChanged } from "./dozo-bot-backups-signal";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

const CATALOG = [
  {
    provider: "provider-a",
    id: "model-a",
    label: "Model A",
    providerName: "Provider A",
    billing: "",
  },
  {
    provider: "provider-a",
    id: "model-b",
    label: "Model B",
    providerName: "Provider A",
    billing: "",
  },
];
const CREDENTIALS = [{ id: "connection-a", provider: "provider-a", label: "Work" }];
const A = { provider: "provider-a", modelId: "model-a", credentialId: "connection-a" };
const B = { provider: "provider-a", modelId: "model-b", credentialId: "connection-a" };

async function render(
  user: string | null = "user-1",
  model: { provider: string; modelId: string } | null = null,
) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value={user}>
          <DozoBotBackups botId="bot-1" spaceId="space-1" model={model} />
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
  if (user) await vi.waitFor(() => expect(container.querySelector("[data-picker]")).not.toBeNull());
}

const click = async (selector: string) => {
  const target = container.querySelector<HTMLButtonElement>(selector);
  if (!target) throw new Error(`missing ${selector}`);
  await act(async () => target.click());
};
const items = () =>
  [...container.querySelectorAll<HTMLButtonElement>("[data-item]")].map((item) => item);
const texts = () => [...container.querySelectorAll("li")].map((row) => row.textContent);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.get.mockReset().mockResolvedValue({ backups: [] });
  api.set.mockReset().mockImplementation(async ({ backups }) => ({ backups }));
  api.credentials.mockReset().mockResolvedValue(CREDENTIALS);
  api.forRole.mockReset().mockResolvedValue(CATALOG);
  api.rests.mockReset().mockResolvedValue({ rests: [] });
  api.toastError.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("DozoBotBackups", () => {
  it("shows one Add fallback line while the bot has none, offering the viewer's models", async () => {
    await render();
    expect(texts()).toEqual([expect.stringContaining("Add fallback")]);
    expect(api.get).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(api.forRole).toHaveBeenCalledWith(
      { role: "main", expectedUserId: "user-1" },
      expect.anything(),
    );
    await click('[data-pick="Add fallback|model-b"]');
    expect(api.set).toHaveBeenCalledWith({ botId: "bot-1", backups: [B] });
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it("lists the bot's backups in order and moves, replaces and removes them", async () => {
    api.get.mockResolvedValue({ backups: [A, B] });
    await render();
    await vi.waitFor(() => expect(texts()[0]).toContain("Model A"));
    expect(texts()[0]).toContain("Work");
    expect(texts()[1]).toContain("Model B");
    // Both models are in the list, so there is nothing left to add.
    expect(container.textContent).not.toContain("Add fallback");
    const rowItems = () => items().map((item) => [item.textContent, item.disabled]);
    expect(rowItems()).toEqual([
      ["Move up", true],
      ["Move down", false],
      ["Remove", false],
      ["Move up", false],
      ["Move down", true],
      ["Remove", false],
    ]);
    await act(async () => items()[1]?.click());
    expect(api.set).toHaveBeenLastCalledWith({ botId: "bot-1", backups: [B, A] });
    await vi.waitFor(() => expect(items()[0]?.disabled).toBe(true));
    await act(async () => items()[3]?.click());
    expect(api.set).toHaveBeenLastCalledWith({ botId: "bot-1", backups: [B, A] });
    await vi.waitFor(() => expect(items()[5]?.disabled).toBe(false));
    await act(async () => items()[2]?.click());
    expect(api.set).toHaveBeenLastCalledWith({ botId: "bot-1", backups: [B] });
  });

  it("replaces one backup with another model from its picker", async () => {
    api.get.mockResolvedValue({ backups: [A] });
    await render();
    await vi.waitFor(() => expect(texts()[0]).toContain("Model A"));
    await click('[data-pick="Change Model A|model-b"]');
    expect(api.set).toHaveBeenCalledWith({ botId: "bot-1", backups: [B] });
  });

  it("names a row by its model when its connection is not the viewer's", async () => {
    api.get.mockResolvedValue({
      backups: [{ provider: "provider-a", modelId: "model-a", credentialId: "someone-elses" }],
    });
    api.credentials.mockResolvedValue([]);
    await render();
    await vi.waitFor(() => expect(texts()[0]).toContain("Model A"));
    api.get.mockResolvedValue({ backups: [{ provider: "provider-x", modelId: "gone" }] });
    await act(async () => {
      await dozoBotBackupsChanged(client);
    });
    await vi.waitFor(() => expect(texts()[0]).toContain("gone"));
  });

  it("says a refused save and goes back to the saved list", async () => {
    api.get.mockResolvedValue({ backups: [A] });
    api.set.mockRejectedValue(new Error("Connect that model provider first"));
    await render();
    await vi.waitFor(() => expect(texts()[0]).toContain("Model A"));
    await act(async () => items().at(-1)?.click());
    await vi.waitFor(() => expect(api.toastError).toHaveBeenCalled());
    expect(texts()[0]).toContain("Model A");
  });

  it("ignores clearing a row or connecting a provider from its picker", async () => {
    api.get.mockResolvedValue({ backups: [A] });
    await render();
    await vi.waitFor(() => expect(texts()[0]).toContain("Model A"));
    for (const label of ["Change Model A", "Add fallback"]) {
      await click(`[data-none="${label}"]`);
      await click(`[data-connect="${label}"]`);
    }
    expect(api.set).not.toHaveBeenCalled();
    expect(texts()).toHaveLength(2);
  });

  it("shows the list it is saving while the save is on its way", async () => {
    api.set.mockReturnValue(new Promise(() => undefined));
    await render();
    await click('[data-pick="Add fallback|model-a"]');
    expect(texts()[0]).toContain("Model A");
    expect(container.querySelector<HTMLButtonElement>("[data-pick]")?.disabled).toBe(true);
  });

  it("offers no Add fallback once the bot has the most backups a list holds", async () => {
    api.get.mockResolvedValue({
      backups: Array.from({ length: 10 }, (_, index) => ({
        provider: "provider-x",
        modelId: `model-${index}`,
      })),
    });
    await render();
    await vi.waitFor(() => expect(texts()).toHaveLength(10));
    expect(container.querySelector('[data-picker="Add fallback"]')).toBeNull();
  });

  it("offers a server's own models and the deployment's, each saved on what serves it", async () => {
    api.credentials.mockResolvedValue([
      ...CREDENTIALS,
      {
        id: "connection-c",
        provider: "openai-compatible",
        label: "Home",
        enabledModelIds: ["local-1"],
      },
    ]);
    api.forRole.mockResolvedValue([
      ...CATALOG,
      {
        provider: "provider-m",
        id: "hosted",
        label: "Hosted",
        providerName: "M",
        billing: "",
        managed: true,
      },
    ]);
    await render();
    await click('[data-pick="Add fallback|local-1"]');
    expect(api.set).toHaveBeenLastCalledWith({
      botId: "bot-1",
      backups: [
        { provider: "openai-compatible", modelId: "local-1", credentialId: "connection-c" },
      ],
    });
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await click('[data-pick="Add fallback|hosted"]');
    expect(api.set).toHaveBeenLastCalledWith({
      botId: "bot-1",
      backups: [{ provider: "provider-m", modelId: "hosted" }],
    });
  });

  it("reads no models to offer before the viewer is known", async () => {
    await render(null);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(api.forRole).not.toHaveBeenCalled();
    expect(container.querySelector("[data-picker]")).toBeNull();
  });

  it("says when a resting model opens again, for the bot's model and each backup", async () => {
    const soon = new Date(Date.now() + 60 * 60_000);
    const later = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    api.get.mockResolvedValue({ backups: [A, B] });
    api.rests.mockResolvedValue({
      rests: [
        // Model A on the "Work" connection; the whole connection only days later.
        { credentialId: "connection-a", modelId: "model-a", opensAt: soon.toISOString() },
        { credentialId: "connection-z", modelId: "", opensAt: later.toISOString() },
        // One that has ended says nothing.
        { credentialId: "connection-a", modelId: "model-b", opensAt: "2020-01-01T00:00:00.000Z" },
      ],
    });
    api.credentials.mockResolvedValue([
      ...CREDENTIALS,
      { id: "connection-z", provider: "provider-z", label: "Other" },
    ]);
    await render("user-1", { provider: "provider-z", modelId: "any" });
    await vi.waitFor(() => expect(texts()[1]).toContain("Opens at"));
    expect(container.querySelector("[data-testid=dozo-model-rests]")?.textContent).toMatch(
      /^Opens at .+/,
    );
    expect(texts()[1]).not.toContain("Work");
    expect(texts()[2]).toContain("Work");
    expect(api.rests).toHaveBeenCalled();
  });

  it("draws nothing until the list is read", async () => {
    api.get.mockReturnValue(new Promise(() => undefined));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <QueryUserProvider value="user-1">
            <DozoBotBackups botId="bot-1" spaceId="space-1" />
          </QueryUserProvider>
        </QueryClientProvider>,
      );
    });
    expect(container.innerHTML).toBe("");
  });
});
