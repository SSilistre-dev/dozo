import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ picked: vi.fn(), applied: vi.fn() }));
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  modelPicked: fake.picked,
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  appliedModelRole: fake.applied,
}));

import { botModelPicked, mainModelPicked } from "./dozo-model-picked.js";

const prisma = { marker: "prisma" } as never;
const actor = { userId: "ada", spaceId: "space-1" };

beforeEach(() => {
  fake.picked.mockReset().mockResolvedValue(undefined);
  fake.applied
    .mockReset()
    .mockResolvedValue({ primary: { provider: "p", modelId: "old" }, backups: [] });
});

describe("botModelPicked", () => {
  const bot = { id: "bot-1", modelProvider: "p", modelId: "old" };

  it("ends the rests of a model picked for the bot in place of another, and passes the bot on", async () => {
    expect(await botModelPicked(prisma, actor, { modelProvider: "p", modelId: "new" }, bot)).toBe(
      bot,
    );
    expect(fake.picked).toHaveBeenCalledWith(prisma, "ada", { provider: "p", modelId: "new" });
  });

  it("ends nothing for a save that keeps the bot's model or names none", async () => {
    await botModelPicked(prisma, actor, { modelProvider: "p", modelId: "old" }, bot);
    await botModelPicked(prisma, actor, {}, bot);
    await botModelPicked(prisma, actor, { modelProvider: null, modelId: null }, bot);
    expect(fake.picked).not.toHaveBeenCalled();
  });
});

describe("mainModelPicked", () => {
  it("ends the rests of a main model saved in place of another", async () => {
    await mainModelPicked(prisma, actor, "main", { provider: "p", modelId: "new" }, "space");
    expect(fake.applied).toHaveBeenCalledWith(prisma, actor, "main", "space");
    expect(fake.picked).toHaveBeenCalledWith(prisma, "ada", { provider: "p", modelId: "new" });
  });

  it("ends them too when there was no main model of the person's", async () => {
    fake.applied.mockResolvedValue({ primary: null, backups: [] });
    await mainModelPicked(prisma, actor, "main", { provider: "p", modelId: "old" });
    expect(fake.picked).toHaveBeenCalled();
  });

  it("ends nothing for the same model, another purpose, or a save without a main model", async () => {
    await mainModelPicked(prisma, actor, "main", {
      provider: "p",
      modelId: "old",
      thinkingLevel: "high",
    });
    await mainModelPicked(prisma, actor, "approval", { provider: "p", modelId: "new" });
    await mainModelPicked(prisma, actor, "main", undefined);
    await mainModelPicked(prisma, actor, "main", null);
    expect(fake.picked).not.toHaveBeenCalled();
  });
});
