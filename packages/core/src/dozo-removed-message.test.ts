import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { dozoRemovedMessageId } from "./dozo-removed-message.js";
import { reduceThreadSnapshot } from "./thread-snapshot-events.js";

const message = (id: string, seq: number): ThreadMessage => ({
  id,
  threadId: "thread-1",
  seq,
  role: "bot",
  blocks: [{ kind: "text", text: id }],
  createdAt: "2026-11-20T10:00:00.000Z",
});

const snapshot = {
  threadId: "thread-1",
  cursor: 10,
  olderCursor: null,
  messages: [message("ask", 4), message("reply", 5)],
  run: null,
  activeRuns: [],
};

describe("dozoRemovedMessageId", () => {
  it("names the message an update takes back", () => {
    expect(
      dozoRemovedMessageId({
        type: "thread.message.updated",
        payload: { messageId: "reply", removed: true },
      }),
    ).toBe("reply");
  });

  it.each([
    ["an ordinary update", { type: "thread.message.updated", payload: { messageId: "reply" } }],
    ["another event type", { type: "thread.message.created", payload: { removed: true } }],
    ["an update without an id", { type: "thread.message.updated", payload: { removed: true } }],
    ["an event without a payload", { type: "thread.message.updated" }],
  ])("names nothing for %s", (_, event) => {
    expect(dozoRemovedMessageId(event)).toBeNull();
  });
});

describe("a removed message in the open chat", () => {
  it("leaves the transcript at once and moves the cursor", () => {
    const next = reduceThreadSnapshot(snapshot, {
      type: "thread.message.updated",
      seq: 11,
      payload: { messageId: "reply", removed: true },
    });
    expect(next?.messages.map(({ id }) => id)).toEqual(["ask"]);
    expect(next?.cursor).toBe(11);
  });

  it("is not applied twice when the stream replays it", () => {
    const next = reduceThreadSnapshot(snapshot, {
      type: "thread.message.updated",
      seq: 9,
      payload: { messageId: "reply", removed: true },
    });
    expect(next).toBe(snapshot);
  });
});
