import { deferred, flush } from "@rakazo/core/test-async";
import { afterEach, expect, it, vi } from "vitest";

const keys = vi.hoisted(() => vi.fn(async (_input: unknown, _options?: unknown) => ({ ok: true })));
vi.mock("../../lib/rpc", () => ({ rpc: { dozoTeach: { keys } } }));

const { closeTeachKeys, queueTeachKey, sendTeachKeysNow } = await import("./dozo-teach-key-batch");
const { enqueueTeachComputerInput } = await import("./teach-computer-input-chain");

afterEach(() => keys.mockClear());

const sent = () => keys.mock.calls.map(([input]) => (input as { keys: string[] }).keys);

it("gathers the keys typed while a request is in flight into the next one", async () => {
  const first = deferred<{ ok: boolean }>();
  keys.mockImplementationOnce(() => first.promise);
  queueTeachKey("bot-1", "a");
  await flush();
  for (const key of "bcd") queueTeachKey("bot-1", key);
  first.resolve({ ok: true });
  await enqueueTeachComputerInput("bot-1", async () => undefined);
  expect(sent()).toEqual([["a"], ["b", "c", "d"]]);
});

it("keeps other bots' keys apart, and splits at the server's limit", async () => {
  for (let index = 0; index < 201; index += 1) queueTeachKey("bot-2", "x");
  queueTeachKey("bot-3", "y");
  await enqueueTeachComputerInput("bot-2", async () => undefined);
  await enqueueTeachComputerInput("bot-3", async () => undefined);
  expect(sent().map((batch) => batch.length)).toEqual([200, 1, 1]);
});

it("starts a new batch after anything else is queued", async () => {
  queueTeachKey("bot-4", "a");
  closeTeachKeys("bot-4");
  queueTeachKey("bot-4", "b");
  await enqueueTeachComputerInput("bot-4", async () => undefined);
  expect(sent()).toEqual([["a"], ["b"]]);
});

it("sends what is not sent yet on requests that outlive the page, once", async () => {
  const first = deferred<{ ok: boolean }>();
  keys.mockImplementationOnce(() => first.promise);
  queueTeachKey("bot-5", "a");
  await flush();
  queueTeachKey("bot-5", "b");
  sendTeachKeysNow();
  expect(keys.mock.calls[1]).toEqual([
    { botId: "bot-5", keys: ["b"] },
    { context: { keepalive: true } },
  ]);
  first.resolve({ ok: true });
  await enqueueTeachComputerInput("bot-5", async () => undefined);
  expect(keys).toHaveBeenCalledTimes(2);
  // Nothing is left to send.
  sendTeachKeysNow();
  expect(keys).toHaveBeenCalledTimes(2);
});
