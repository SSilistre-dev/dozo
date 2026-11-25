import { describe, expect, it } from "vitest";
import { DOZO_MESSAGE_PINS_MAX, dozoMessagePinsContract } from "./dozo-message-pins.js";
import { appContract } from "./rpc/app-contract.js";

const pinInput = dozoMessagePinsContract.pin["~orpc"].inputSchema!;
const pinsOutput = dozoMessagePinsContract.pins["~orpc"].outputSchema!;

describe("message pins contract", () => {
  it("joins the app contract beside editing and regenerating", () => {
    expect(appContract.dozoMessages.pins).toBe(dozoMessagePinsContract.pins);
    expect(appContract.dozoMessages.pin).toBe(dozoMessagePinsContract.pin);
  });

  it("says whether to pin or unpin", async () => {
    const input = { threadId: "thread-1", messageId: "message-1" };
    expect(await pinInput["~standard"].validate({ ...input, pinned: false })).toEqual({
      value: { ...input, pinned: false },
    });
    expect(await pinInput["~standard"].validate(input)).toHaveProperty("issues");
  });

  it("answers with at most the pins a chat holds", async () => {
    const pin = { messageId: "message-1", preview: { role: "bot", text: "Pasta." } };
    const pins = (count: number) => ({ pins: Array.from({ length: count }, () => pin) });
    expect(await pinsOutput["~standard"].validate(pins(DOZO_MESSAGE_PINS_MAX))).toHaveProperty(
      "value",
    );
    expect(await pinsOutput["~standard"].validate(pins(DOZO_MESSAGE_PINS_MAX + 1))).toHaveProperty(
      "issues",
    );
  });
});
