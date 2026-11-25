import { describe, expect, it } from "vitest";
import { dozoQueueContract } from "./dozo-queue.js";
import { appContract } from "./rpc/app-contract.js";

const check = (schema: unknown, value: unknown) =>
  (schema as { "~standard": { validate: (v: unknown) => Promise<{ issues?: unknown[] }> } })[
    "~standard"
  ].validate(value);
const listInput = dozoQueueContract.list["~orpc"].inputSchema!;
const cancelInput = dozoQueueContract.cancelWaiting["~orpc"].inputSchema!;

describe("waiting work contract", () => {
  it("joins the app contract", () => {
    expect(appContract.dozoQueue).toBe(dozoQueueContract);
  });

  it("reads one bot or one group, never both or neither", async () => {
    expect((await check(listInput, { botId: "b" })).issues).toBeUndefined();
    expect((await check(listInput, { groupId: "g" })).issues).toBeUndefined();
    expect((await check(listInput, { botId: "b", groupId: "g" })).issues).toBeDefined();
    expect((await check(listInput, {})).issues).toBeDefined();
  });

  it("cancels a run or a message, one at a time", async () => {
    expect((await check(cancelInput, { runId: "r" })).issues).toBeUndefined();
    expect((await check(cancelInput, { messageId: "m" })).issues).toBeUndefined();
    expect((await check(cancelInput, {})).issues).toBeDefined();
  });

  it("describes an item with a place in line from 1", async () => {
    const output = dozoQueueContract.list["~orpc"].outputSchema!;
    const item = {
      id: "r",
      kind: "run",
      botId: "b",
      position: 1,
      mine: false,
      reason: "bot_busy",
      waitingFor: null,
      label: null,
    };
    expect((await check(output, { items: [item] })).issues).toBeUndefined();
    expect((await check(output, { items: [{ ...item, position: 0 }] })).issues).toBeDefined();
    expect((await check(output, { items: [{ ...item, reason: "other" }] })).issues).toBeDefined();
  });

  it("accepts every reason a piece of work waits, with no name or label given", async () => {
    const output = dozoQueueContract.list["~orpc"].outputSchema!;
    const item = { id: "r", kind: "message", botId: "b", position: 2, mine: false };
    for (const reason of ["bot_busy", "computer_busy", "behind_run"]) {
      expect((await check(output, { items: [{ ...item, reason }] })).issues).toBeUndefined();
    }
  });
});
