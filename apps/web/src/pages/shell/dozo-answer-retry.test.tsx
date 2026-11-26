// @vitest-environment jsdom

import type { ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPageSession } from "../../lib/pages/pages";
import { createQueryRoot } from "../../lib/query/query-root.test-support";
import type { createSpaceRpc } from "../../lib/query/rpc";
import { useComposerActions } from "./composer/use-composer-actions";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t, i18n: { locale: "en" } }) };
});

const answer = vi.fn();
let root: ReturnType<typeof createQueryRoot>;
let latest: ReturnType<typeof useComposerActions>;
const pageSession = createPageSession();
const ref = <T,>(current: T) => ({ current });
const activeBotId = ref<string | undefined>("bot-1");
const activeGroupId = ref<string | undefined>(undefined);
const refreshThread = vi.fn(async () => ({}) as ThreadSnapshot);
const none = () => undefined;

function Harness() {
  latest = useComposerActions({
    rpc: { threads: { answer } } as unknown as ReturnType<typeof createSpaceRpc>,
    pageSession,
    activeId: "bot-1",
    inGroup: false,
    groupId: undefined,
    activeBotId,
    activeGroupId,
    botsRef: ref([]),
    bootstrapMe: null,
    activeSnapshot: null,
    navigate: vi.fn() as never,
    refreshBots: async () => undefined,
    refreshThreadRef: ref(refreshThread),
    refreshGroupThreadRef: ref(async () => ({}) as ThreadSnapshot),
    updateSnapshot: none,
    terminalRunReceipts: ref(new Set<string>()),
    computerRef: ref(null),
    commitComputer: none,
    clearReadBoundary: none,
    flushPendingBrowserNotifications: none,
  } as unknown as Parameters<typeof useComposerActions>[0]);
  return null;
}

const message = { id: "message-1", runId: "run-1" } as ThreadMessage;
/** What oRPC's web client throws for a proxy's page instead of an API error. */
const proxyPage = (status: number, code: string) =>
  Object.assign(new Error(code), { status, code, data: { status, headers: {}, body: "" } });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  answer.mockReset();
  refreshThread.mockClear();
  root = createQueryRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it("keeps an answer pending and sends it again while the proxy has no API to reach", async () => {
  answer
    .mockRejectedValueOnce(proxyPage(404, "NOT_FOUND"))
    .mockRejectedValueOnce(proxyPage(502, "BAD_GATEWAY"))
    .mockResolvedValue({ ok: true });
  const settled = vi.fn();
  let answered!: Promise<void>;
  await act(async () => {
    answered = latest.answerMessage(message, "allow").then(settled);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(answer).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  await answered;
  expect(answer).toHaveBeenCalledTimes(3);
  expect(answer.mock.calls.every((call) => call[0].answer === "allow")).toBe(true);
  expect(refreshThread).toHaveBeenCalledWith("bot-1");
});

it("fails once the minute is up so the card can be answered again", async () => {
  answer.mockRejectedValue(proxyPage(503, "SERVICE_UNAVAILABLE"));
  let failure!: Promise<unknown>;
  await act(async () => {
    failure = latest.answerMessage(message, "allow").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(64_000);
  });
  await expect(failure).resolves.toMatchObject({ status: 503 });
  expect(answer).toHaveBeenCalledTimes(11);
});
