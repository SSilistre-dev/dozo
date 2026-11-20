import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoAccessTokensRoutes, dozoTokenAuthenticator } from "./dozo-access-tokens.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";
import { AUDITED_PROCEDURES } from "./security-audit.js";

const spies = vi.hoisted(() => ({
  resolve: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  find: vi.fn(),
  banned: vi.fn(),
}));
vi.mock("./thread-target.js", () => ({ resolveThreadTarget: spies.resolve }));
vi.mock("@rakazo/auth", () => ({ emailBanned: spies.banned }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  createDozoAccessToken: spies.create,
  listDozoAccessTokens: spies.list,
  revokeDozoAccessToken: spies.revoke,
  findDozoAccessToken: spies.find,
}));

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const prisma = {} as RouterDeps["prisma"];

function client() {
  const ctx = createRouterContext({ prisma } as RouterDeps);
  return createRouterClient(dozoAccessTokensRoutes(ctx), { context: { actor } });
}

const createdAt = new Date("2026-11-21T10:00:00.000Z");
const row = {
  id: "token-1",
  name: "CI",
  botId: null,
  botName: null,
  hint: "abcd",
  createdAt,
  lastUsedAt: null,
};

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockReset();
});

describe("settings procedures", () => {
  it("lists the member's tokens without the tokens themselves", async () => {
    spies.list.mockResolvedValue([
      { ...row, botId: "bot-1", botName: "Chef", lastUsedAt: createdAt },
    ]);
    expect(await client().dozoAccessTokens.list()).toEqual([
      {
        id: "token-1",
        name: "CI",
        botId: "bot-1",
        botName: "Chef",
        hint: "abcd",
        createdAt: "2026-11-21T10:00:00.000Z",
        lastUsedAt: "2026-11-21T10:00:00.000Z",
      },
    ]);
    expect(spies.list).toHaveBeenCalledWith(prisma, actor);
  });

  it("makes a token for every bot and shows it once", async () => {
    spies.create.mockResolvedValue({ token: "dozo_pat_secret", row });
    const made = await client().dozoAccessTokens.create({ name: "  CI  " });
    expect(made.token).toBe("dozo_pat_secret");
    expect(made.accessToken).toMatchObject({ id: "token-1", botId: null, botName: null });
    expect(spies.resolve).not.toHaveBeenCalled();
    expect(spies.create).toHaveBeenCalledWith(prisma, actor, { name: "CI", botId: null });
  });

  it("limits a token to a bot only the member can talk to", async () => {
    spies.resolve.mockResolvedValue({
      kind: "bot",
      botId: "bot-1",
      bot: { id: "bot-1", name: "Chef" },
    });
    spies.create.mockResolvedValue({ token: "dozo_pat_secret", row: { ...row, botId: "bot-1" } });
    const made = await client().dozoAccessTokens.create({ name: "CI", botId: "bot-1" });
    expect(spies.resolve).toHaveBeenCalledWith(prisma, actor, { botId: "bot-1" });
    expect(spies.create).toHaveBeenCalledWith(prisma, actor, { name: "CI", botId: "bot-1" });
    expect(made.accessToken).toMatchObject({ botId: "bot-1", botName: "Chef" });

    spies.resolve.mockRejectedValue(new IsolationError());
    await expect(
      client().dozoAccessTokens.create({ name: "CI", botId: "bot-2" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(spies.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a token past the limit and a name that is only spaces", async () => {
    spies.create.mockResolvedValue(null);
    const refused = await client()
      .dozoAccessTokens.create({ name: "CI" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ClientError);
    expect((refused as ClientError).kind).toBe("CONFLICT");
    await expect(client().dozoAccessTokens.create({ name: "   " })).rejects.toThrow();
  });

  it("revokes the member's own token", async () => {
    spies.revoke.mockResolvedValue(true);
    expect(await client().dozoAccessTokens.revoke({ id: "token-1" })).toEqual({ ok: true });
    expect(spies.revoke).toHaveBeenCalledWith(prisma, actor, "token-1");
  });

  it("puts making and revoking a token in the activity log, never the token", () => {
    expect(AUDITED_PROCEDURES["dozoAccessTokens.create"]).toEqual({
      type: "credential.created",
      kind: "access_token",
      fields: ["botId"],
    });
    expect(AUDITED_PROCEDURES["dozoAccessTokens.revoke"]).toMatchObject({
      type: "credential.deleted",
    });
  });
});

describe("dozoTokenAuthenticator", () => {
  const token = `dozo_pat_${"a".repeat(43)}`;
  const owner = {
    id: "token-1",
    userId: "user-1",
    spaceId: "space-1",
    botId: "bot-1",
    email: "user@example.test",
    deactivated: false,
  };
  const authenticate = dozoTokenAuthenticator(prisma);

  it("answers the member, Space and bot for a bearer token", async () => {
    spies.find.mockResolvedValue(owner);
    spies.banned.mockResolvedValue(false);
    expect(await authenticate(`Bearer ${token}`)).toEqual({
      tokenId: "token-1",
      botId: "bot-1",
      actor: {
        userId: "user-1",
        spaceId: "space-1",
        email: "user@example.test",
        isDeploymentOwner: false,
      },
    });
    expect(spies.find).toHaveBeenCalledWith(prisma, token);
    // The scheme's name is not case-sensitive.
    expect(await authenticate(`bearer ${token}`)).not.toBeNull();
  });

  it("looks nothing up for a missing, malformed or differently sent token", async () => {
    for (const header of [
      undefined,
      "",
      token,
      `Basic ${token}`,
      `Bearer ${token} extra`,
      "Bearer dozo_pat_short",
      `Bearer ${"x".repeat(52)}`,
    ])
      expect(await authenticate(header)).toBeNull();
    expect(spies.find).not.toHaveBeenCalled();
  });

  it("refuses a revoked token and the token of a deactivated or banned account", async () => {
    spies.find.mockResolvedValueOnce(null);
    expect(await authenticate(`Bearer ${token}`)).toBeNull();
    spies.find.mockResolvedValueOnce({ ...owner, deactivated: true });
    expect(await authenticate(`Bearer ${token}`)).toBeNull();
    spies.find.mockResolvedValueOnce(owner);
    spies.banned.mockResolvedValueOnce(true);
    expect(await authenticate(`Bearer ${token}`)).toBeNull();
    expect(spies.banned).toHaveBeenCalledWith(prisma, "user@example.test");
  });
});
