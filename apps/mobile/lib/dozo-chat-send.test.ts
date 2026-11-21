import type { RpcInput } from "@rakazo/contracts";
import { resolveComposerSendPlan } from "@rakazo/core";
import { expect, it, vi } from "vitest";
import { answerThreadMessage } from "./thread-answer";
import type { SendAttempt, SendPayload } from "./thread-feedback";
import { deliverSend } from "./thread-feedback";

vi.mock("./haptics", () => ({ hapticSuccess: vi.fn() }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({}));

const plan = resolveComposerSendPlan({ text: "hello", mentions: [], hasAttachments: false });
const attempt = {
  clientNonce: "nonce-1",
  artifactIds: new Map(),
} as unknown as SendAttempt;

function payload(overrides: Partial<SendPayload>): SendPayload {
  return {
    originThreadKey: "bot-1",
    displayText: "hello",
    replyPreview: null,
    initialBotTarget: "bot-1",
    botTarget: "bot-1",
    reroutedToGroup: false,
    plan,
    attachments: [],
    replyQuote: null,
    ...overrides,
  };
}

async function sent(overrides: Partial<SendPayload>) {
  const request = vi.fn(async (_name: string, _body: Record<string, unknown>) => ({
    runId: "run-1",
    taskId: "task-1",
    seq: 4,
  }));
  await deliverSend(payload(overrides), attempt, request as never);
  return request.mock.calls;
}

// Delivery, which a retry and a restart repeat, is the one place an unsent message learns its chat.
it("sends a message in a bot's extra chat as chatBotId and chatId, never as botId", async () => {
  const [name, body] = (await sent({ originThreadKey: "chat-1", chatId: "chat-1" }))[0]!;
  expect(name).toBe("threads/send");
  expect(body).toMatchObject({ chatBotId: "bot-1", chatId: "chat-1", text: "hello" });
  expect(body).not.toHaveProperty("botId");
});

it("sends a bot's main chat and a group as before", async () => {
  const [, main] = (await sent({}))[0]!;
  expect(main).toMatchObject({ botId: "bot-1" });
  expect(main).not.toHaveProperty("chatId");
  const [, group] = (
    await sent({ botTarget: undefined, groupTarget: "group-1", originThreadKey: "group-1" })
  )[0]!;
  expect(group).toMatchObject({ groupId: "group-1" });
  expect(group).not.toHaveProperty("botId");
});

it("runs routines in the extra chat the message was written in", async () => {
  const forced = { ...plan, shouldSend: false, shouldRunRoutines: true, routineIds: ["routine-1"] };
  const calls = await sent({ chatId: "chat-1", plan: forced });
  expect(calls[0]![0]).toBe("threads/sendWithRoutines");
  expect(calls[0]![1]).toMatchObject({ chatBotId: "bot-1", chatId: "chat-1" });
  expect(calls[0]![1]).not.toHaveProperty("botId");
});

it("remembers the extra chat of an unsent message through a restart", async () => {
  // The outbox keeps the payload as JSON and sends what it reads back.
  const stored = JSON.parse(JSON.stringify(payload({ chatId: "chat-1" }))) as SendPayload;
  const request = vi.fn(async (_name: string, _body: Record<string, unknown>) => ({
    runId: "run-1",
    taskId: "task-1",
    seq: 4,
  }));
  await deliverSend(stored, attempt, request as never);
  expect(request.mock.calls[0]![1]).toMatchObject({ chatBotId: "bot-1", chatId: "chat-1" });
});

type Answer = RpcInput<"threads/answer">;
function answerContext(overrides: Record<string, unknown>) {
  const rpc = vi.fn(async (_proc: "threads/answer", _body: Answer) => ({}));
  return {
    rpc,
    context: {
      botId: "bot-1" as string | undefined,
      groupId: undefined as string | undefined,
      readOnly: false,
      rpc,
      isCurrentTarget: () => false,
      isFocused: () => false,
      refresh: async () => undefined,
      markRead: vi.fn(),
      ...overrides,
    },
  };
}

it("answers a card in an extra chat in that chat", async () => {
  const { rpc, context } = answerContext({ chatId: "chat-1" });
  await answerThreadMessage(context, { id: "message-1", runId: "run-1" }, "yes");
  const body = rpc.mock.calls[0]![1] as Record<string, unknown>;
  expect(body).toMatchObject({
    chatBotId: "bot-1",
    chatId: "chat-1",
    runId: "run-1",
    answer: "yes",
  });
  expect(body).not.toHaveProperty("botId");
});

it("answers a card in a bot's main chat and a group as before", async () => {
  const main = answerContext({});
  await answerThreadMessage(main.context, { id: "message-1", runId: "run-1" }, "yes");
  expect(main.rpc.mock.calls[0]![1]).toEqual({
    botId: "bot-1",
    runId: "run-1",
    messageId: "message-1",
    answer: "yes",
  });
  const group = answerContext({ botId: undefined, groupId: "group-1" });
  await answerThreadMessage(group.context, { id: "message-1", runId: "run-1" }, "yes");
  expect(group.rpc.mock.calls[0]![1]).toMatchObject({ groupId: "group-1" });
});
