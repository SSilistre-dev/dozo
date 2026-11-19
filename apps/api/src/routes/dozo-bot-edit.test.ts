import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireBotRunEditor, requireGroupRemover } from "./dozo-bot-edit.js";

const { requireSpaceOwner } = vi.hoisted(() => ({ requireSpaceOwner: vi.fn() }));
vi.mock("@rakazo/db", () => ({ requireSpaceOwner }));

const actor: Actor = {
  userId: "member",
  spaceId: "space",
  email: "member@example.test",
  isDeploymentOwner: false,
};
const bot = {
  userId: "creator",
  instructions: "Plan meals.",
  dailyCheckIns: false,
  disabledBuiltinTools: ["web_search"],
  memoryScope: null,
};

function db(group: { userId: string } | null = null) {
  return {
    spaceMember: {},
    chatGroup: { findFirst: vi.fn(async () => group) },
  } as unknown as Parameters<typeof requireBotRunEditor>[0];
}

beforeEach(() => requireSpaceOwner.mockReset());

describe("requireBotRunEditor", () => {
  it("lets the creator change anything without asking who owns the space", async () => {
    await requireBotRunEditor(
      db(),
      actor,
      { ...bot, userId: actor.userId },
      {
        botId: "bot",
        instructions: "Other",
      },
    );
    await requireBotRunEditor(db(), actor, { ...bot, userId: actor.userId });
    expect(requireSpaceOwner).not.toHaveBeenCalled();
  });

  it("asks for the space owner when someone else changes a run setting", async () => {
    await requireBotRunEditor(db(), actor, bot, { botId: "bot", dailyCheckIns: true });
    await requireBotRunEditor(db(), actor, bot, { botId: "bot", disabledBuiltinTools: [] });
    await requireBotRunEditor(db(), actor, bot);
    expect(requireSpaceOwner).toHaveBeenCalledTimes(3);
    expect(requireSpaceOwner).toHaveBeenCalledWith(expect.anything(), actor);
  });

  it("leaves names, looks and unchanged settings open to every member", async () => {
    await requireBotRunEditor(db(), actor, bot, {
      botId: "bot",
      name: "Head chef",
      color: "#000000",
      instructions: "Plan meals.",
      disabledBuiltinTools: ["web_search"],
      memoryScope: null,
    });
    expect(requireSpaceOwner).not.toHaveBeenCalled();
  });

  it("passes the space owner's refusal on", async () => {
    requireSpaceOwner.mockRejectedValueOnce(new Error("forbidden"));
    await expect(
      requireBotRunEditor(db(), actor, bot, { botId: "bot", instructions: "Other" }),
    ).rejects.toThrow("forbidden");
  });
});

describe("requireGroupRemover", () => {
  it("asks for the space owner only for someone else's group in this space", async () => {
    await requireGroupRemover(db({ userId: actor.userId }), actor, "group");
    await requireGroupRemover(db(null), actor, "group");
    expect(requireSpaceOwner).not.toHaveBeenCalled();

    const other = db({ userId: "creator" });
    await requireGroupRemover(other, actor, "group");
    expect(requireSpaceOwner).toHaveBeenCalledOnce();
    expect(other.chatGroup.findFirst).toHaveBeenCalledWith({
      where: { id: "group", spaceId: actor.spaceId },
      select: { userId: true },
    });
  });
});
