import { createRouterClient } from "@orpc/server";
import { ClientError } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoModelPoolRoutes } from "./dozo-model-pool.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const fake = vi.hoisted(() => ({
  read: vi.fn(),
  set: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  readDozoModelPool: fake.read,
  setDozoModelPool: fake.set,
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  recordAuditEvent: fake.audit,
}));

const POOL = {
  connections: [
    { credentialId: "a", pooled: true },
    { credentialId: "b", pooled: true },
  ],
};
const publishRosterChange = vi.fn(async () => undefined);
const prisma = { space: { findUnique: async () => null } };
const secrets = { load: vi.fn() };

function client(userId: string | null) {
  const ctx = createRouterContext({
    prisma,
    secrets,
    events: { notify: () => undefined, publishSpaceChange: () => undefined, publishRosterChange },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(dozoModelPoolRoutes(ctx), {
    context: {
      actor: userId
        ? {
            userId,
            spaceId: `space-${userId}`,
            email: `${userId}@example.test`,
            isDeploymentOwner: false,
          }
        : null,
    },
  }).dozoModelPool;
}

describe("model pool routes", () => {
  beforeEach(() => {
    fake.read.mockReset().mockResolvedValue({ connections: [] });
    fake.set.mockReset().mockResolvedValue({ pool: POOL, provider: "provider-a" });
    fake.audit.mockReset().mockResolvedValue(undefined);
    publishRosterChange.mockClear();
  });

  it("reads the caller's own pool", async () => {
    expect(await client("ada").get()).toEqual({ connections: [] });
    expect(fake.read).toHaveBeenCalledWith({ prisma, secretStore: secrets }, "ada");
  });

  it("switches the pool, records it and signals only the caller's apps", async () => {
    expect(await client("ada").set({ credentialId: "a", pooled: true })).toEqual(POOL);
    expect(fake.set).toHaveBeenCalledWith({ prisma, secretStore: secrets }, "ada", {
      credentialId: "a",
      pooled: true,
    });
    expect(fake.audit).toHaveBeenCalledWith({
      action: "model.pool.changed",
      actor: { type: "user", id: "ada" },
      spaceId: "space-ada",
      userId: "ada",
      target: { type: "model_provider", id: "provider-a" },
      metadata: { pooled: true },
    });
    expect(publishRosterChange).toHaveBeenCalledWith({ userIds: ["ada"] });
  });

  it("passes a refusal on and records nothing", async () => {
    fake.set.mockRejectedValue(new ClientError("BAD_REQUEST", "No pool here."));
    await expect(client("ada").set({ credentialId: "s", pooled: true })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(fake.audit).not.toHaveBeenCalled();
    expect(publishRosterChange).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not signed in", async () => {
    await expect(client(null).get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fake.read).not.toHaveBeenCalled();
  });
});
