import { createRouterClient } from "@orpc/server";
import type { Actor, ThreadMessage } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";
import { dozoChatExportRoutes } from "./dozo-chat-export.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const spies = vi.hoisted(() => ({
  resolve: vi.fn(),
  loadPage: vi.fn(),
}));
vi.mock("./thread-target.js", () => ({ resolveThreadTarget: spies.resolve }));
vi.mock("./thread-message-pages.js", () => ({ loadMessagePage: spies.loadPage }));

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

const findBots = vi.fn();

function client() {
  const deps = { prisma: { bot: { findMany: findBots } } } as unknown as RouterDeps;
  const ctx = createRouterContext(deps);
  return createRouterClient(dozoChatExportRoutes(ctx), { context: { actor } });
}

const botMessage = (botId: string, text: string, createdAt = "2026-11-20T10:00:00.000Z") =>
  ({
    id: `m-${botId}-${text}`,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    botId,
    blocks: [{ kind: "text", text }],
    createdAt,
  }) as ThreadMessage;

beforeEach(() => {
  spies.resolve.mockReset();
  spies.loadPage.mockReset();
  findBots.mockReset();
});

it("exports a bot chat through the transcript's own access check and page reader", async () => {
  spies.resolve.mockResolvedValue({
    kind: "bot",
    botId: "bot-1",
    threadId: "thread-1",
    bot: { id: "bot-1", name: "Ada" },
  });
  spies.loadPage.mockResolvedValue({
    threadId: "thread-1",
    messages: [botMessage("bot-1", "Hello")],
    olderCursor: null,
  });

  const result = await client().dozoChatExport.markdown({
    botId: "bot-1",
    timeZone: "Europe/Istanbul",
  });

  expect(spies.resolve).toHaveBeenCalledWith(
    expect.anything(),
    actor,
    expect.objectContaining({ botId: "bot-1" }),
    { includeArchived: true },
  );
  expect(spies.loadPage).toHaveBeenCalledWith(expect.anything(), "thread-1", undefined, 200);
  expect(result).toEqual({
    markdown: "# Ada\n\n**Ada** · 2026-11-20 13:00\n\nHello\n",
    truncated: false,
  });
  expect(findBots).not.toHaveBeenCalled();
});

it("names a group's members and reads departed bots' names in the caller's Space only", async () => {
  spies.resolve.mockResolvedValue({
    kind: "group",
    groupId: "group-1",
    threadId: "thread-1",
    groupName: "Kitchen",
    members: [{ botId: "bot-1", name: "Ada" }],
    memberBotIds: ["bot-1"],
  });
  spies.loadPage.mockResolvedValue({
    threadId: "thread-1",
    messages: [botMessage("bot-2", "Earlier"), botMessage("bot-1", "Later")],
    olderCursor: null,
  });
  findBots.mockResolvedValue([{ id: "bot-2", name: "Bo" }]);

  const result = await client().dozoChatExport.markdown({
    groupId: "group-1",
    since: "2026-11-01T00:00:00.000Z",
  });

  expect(findBots).toHaveBeenCalledWith({
    where: { id: { in: ["bot-2"] }, spaceId: "space-1" },
    select: { id: true, name: true },
  });
  expect(result.markdown).toBe(
    "# Kitchen\n\n**Bo** · 2026-11-20 10:00\n\nEarlier\n\n**Ada** · 2026-11-20 10:00\n\nLater\n",
  );
});

it("refuses a chat the caller cannot open, before reading any message", async () => {
  spies.resolve.mockRejectedValue(new IsolationError());

  await expect(client().dozoChatExport.markdown({ botId: "bot-9" })).rejects.toBeInstanceOf(
    IsolationError,
  );
  expect(spies.loadPage).not.toHaveBeenCalled();
});

it("asks for exactly one chat", async () => {
  await expect(client().dozoChatExport.markdown({})).rejects.toThrow();
  await expect(
    client().dozoChatExport.markdown({ botId: "bot-1", groupId: "group-1" }),
  ).rejects.toThrow();
  expect(spies.resolve).not.toHaveBeenCalled();
});
