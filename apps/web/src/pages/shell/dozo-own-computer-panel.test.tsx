// @vitest-environment jsdom
import type { Bot, ComputerMode } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: the brand rules put OwnComputerRow into the bot panel and route a
// refused switch to it. The row itself is covered by dozo-own-computer-row.test.tsx.

vi.mock("../../lib/rpc", () => {
  const rpc = {
    bots: { emailAddress: vi.fn(async () => null), list: vi.fn(async () => []) },
    voice: { voices: vi.fn(async () => []) },
    models: { credentials: vi.fn(async () => []), list: vi.fn(async () => []) },
    me: vi.fn(async () => null),
  };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("../../components/SubscriptionGate", () => ({ useBilling: () => ({ status: null }) }));
vi.mock("../../components/pages/PagesList", () => ({ PagesList: () => null }));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));
vi.mock("./dozo-bot-skills-section", () => ({ DozoBotSkillsSection: () => null }));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));

const row = vi.hoisted(() => ({
  last: null as null | {
    mode: ComputerMode;
    refusal: string | null;
    onChange: (mode: ComputerMode) => void;
  },
}));
vi.mock("./dozo-own-computer-row", () => ({
  OwnComputerRow: (props: NonNullable<typeof row.last>) => {
    row.last = props;
    return null;
  },
}));

import { BotSettings } from "./bot-panel";

const bot = {
  id: "bot-1",
  spaceId: "space-1",
  name: "Ada",
  title: "Helper",
  description: "",
  instructions: "",
  color: "ink",
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-1",
  preview: "",
  status: "idle",
  runErrorId: null,
  computerMode: "team",
  updatedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  fleetManagement: true,
  replyMode: "chat",
  disabledBuiltinTools: [],
  webhookConfigured: false,
  spawnKey: null,
} as unknown as Bot;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onSave = vi.fn(async (_patch: object) => undefined);

/** The panel's own error line at its foot. */
const footError = () => host.querySelector("p.text-destructive")?.textContent ?? null;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSave.mockReset().mockResolvedValue(undefined);
  row.last = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BotSettings
          bot={bot}
          onSave={onSave}
          onExport={async () => undefined}
          onClear={() => undefined}
        />
      </QueryClientProvider>,
    ),
  );
  await act(flush);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("says why a refused switch went back beside the switch, not at the foot of the panel", async () => {
  expect(row.last).toMatchObject({ mode: "team", refusal: null });
  onSave.mockRejectedValueOnce(new Error("Stop the bot first"));
  await act(async () => row.last!.onChange("dedicated"));
  await act(flush);
  expect(onSave.mock.lastCall?.[0]).toMatchObject({ computerMode: "dedicated" });
  expect(row.last).toMatchObject({ mode: "team", refusal: "Stop the bot first" });
  expect(footError()).toBeNull();
  // Trying again clears it until the server answers.
  await act(async () => row.last!.onChange("dedicated"));
  await act(flush);
  expect(row.last).toMatchObject({ mode: "dedicated", refusal: null });
});

it("keeps other refused saves at the foot of the panel", async () => {
  onSave.mockRejectedValueOnce(new Error("offline"));
  await act(async () => host.querySelector<HTMLElement>('[id$="-notify-finish"]')!.click());
  await act(flush);
  expect(row.last?.refusal).toBeNull();
  expect(footError()).toBe("offline");
});
