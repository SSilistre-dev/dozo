import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForModelOAuth } from "./models/model-auth";
import { rpc } from "./query/rpc";

vi.mock("./query/rpc", () => ({
  rpc: { models: { completeOAuth: vi.fn() } },
}));

describe("waitForModelOAuth interval", () => {
  const completeOAuth = vi.mocked(rpc.models.completeOAuth);

  beforeEach(() => {
    completeOAuth.mockReset();
  });

  it("checks again after the interval it was given", async () => {
    vi.useFakeTimers();
    try {
      completeOAuth.mockResolvedValueOnce({ status: "pending" });
      completeOAuth.mockResolvedValueOnce({ status: "ready" });
      const waiting = waitForModelOAuth("login-id", undefined, undefined, 1000);

      await vi.advanceTimersByTimeAsync(999);
      expect(completeOAuth).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toMatchObject({ status: "ready" });
      expect(completeOAuth).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
