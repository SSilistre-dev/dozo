import { describe, expect, it } from "vitest";
import { dozoMessagesContract } from "./dozo-message-revision.js";
import { appContract } from "./rpc.js";

const editInput = dozoMessagesContract.edit["~orpc"].inputSchema!;

describe("message revision contract", () => {
  it("joins the app contract", () => {
    expect(appContract.dozoMessages).toBe(dozoMessagesContract);
  });

  it("sends the edited text trimmed", async () => {
    const parsed = await editInput["~standard"].validate({
      threadId: "thread-1",
      messageId: "message-1",
      text: "  Plan lunch \n",
    });
    expect(parsed).toEqual({
      value: { threadId: "thread-1", messageId: "message-1", text: "Plan lunch" },
    });
  });

  it("refuses an empty edit", async () => {
    const parsed = await editInput["~standard"].validate({
      threadId: "thread-1",
      messageId: "message-1",
      text: "   ",
    });
    expect(parsed).toHaveProperty("issues");
  });
});
