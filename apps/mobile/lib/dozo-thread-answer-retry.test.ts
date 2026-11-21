import { describe, expect, it, vi } from "vitest";
import type { ThreadAnswerContext } from "./thread-answer";
import { answerThreadMessage } from "./thread-answer";

vi.mock("./haptics", () => ({ hapticSuccess: vi.fn() }));

/** What the mobile client throws for a gateway answer: a status and no API code. */
const gateway = () => Object.assign(new Error("Bad gateway"), { status: 502, code: undefined });

function context(rpc: ThreadAnswerContext["rpc"]): ThreadAnswerContext {
  return {
    botId: "bot-1",
    groupId: undefined,
    readOnly: false,
    rpc,
    isCurrentTarget: () => true,
    isFocused: () => false,
    refresh: async () => undefined,
    markRead: () => undefined,
  };
}

describe("answering a card while the API is being replaced", () => {
  it("sends the answer again until the API takes it, staying pending", async () => {
    vi.useFakeTimers();
    try {
      const rpc = vi
        .fn<ThreadAnswerContext["rpc"]>()
        .mockRejectedValueOnce(gateway())
        .mockRejectedValueOnce(gateway())
        .mockResolvedValue(undefined);
      const settled = vi.fn();
      const answered = answerThreadMessage(
        context(rpc),
        { id: "message-1", runId: "run-1" },
        "allow",
      ).then(settled);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await answered;
      expect(rpc).toHaveBeenCalledTimes(3);
      expect(new Set(rpc.mock.calls.map((call) => JSON.stringify(call))).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not repeat an answer the API refused", async () => {
    const refusal = Object.assign(new Error("No longer awaiting"), {
      status: 409,
      code: "CONFLICT",
    });
    const rpc = vi.fn<ThreadAnswerContext["rpc"]>().mockRejectedValue(refusal);
    await expect(
      answerThreadMessage(context(rpc), { id: "message-1", runId: "run-1" }, "allow"),
    ).rejects.toBe(refusal);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
