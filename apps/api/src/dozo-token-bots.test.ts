import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { dozoTokenOwnBots } from "./dozo-token-bots.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

it("names only the bots the member made in this Space and has not archived", async () => {
  const findMany = vi.fn().mockResolvedValue([{ id: "bot-1", name: "Chef" }]);
  const prisma = { bot: { findMany } } as unknown as PrismaClient;
  expect(await dozoTokenOwnBots(prisma, actor)).toEqual([{ id: "bot-1", name: "Chef" }]);
  expect(findMany).toHaveBeenCalledWith({
    where: { spaceId: "space-1", userId: "user-1", archivedAt: null },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
});
