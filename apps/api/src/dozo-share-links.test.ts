import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { appContract, DOZO_SHARE_LINK_API_PREFIX, dozoFeaturesContract } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { dozoFeatureRoutes } from "./dozo-features.js";
import type { DozoShareKinds } from "./dozo-share-links.js";
import {
  createShareLink,
  dozoShareLinkRoutes,
  mountDozoShareLinks,
  readSharedLink,
  revokeShareLink,
} from "./dozo-share-links.js";
import type { RouterContext } from "./routes/context.js";

const actor = { userId: "user-1", spaceId: "space-1", email: "a@example.test" } as Actor;
const TOKEN = "A".repeat(43);
const HASH_OF_TOKEN = "a".repeat(64);

type Sql = { text: string; values: unknown[] };

/** Answers each `$queryRaw` with the next of `answers`, recording what was asked. */
function fakeDb(...answers: unknown[][]) {
  const statements: Sql[] = [];
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
      return answers.shift() ?? [];
    }),
  };
  return { prisma: prisma as never, statements };
}

function kinds(payload: unknown = { ok: true }, canShare = true): DozoShareKinds {
  return {
    note: { canShare: vi.fn(async () => canShare), load: vi.fn(async () => payload) },
  };
}

const row = {
  id: "link-1",
  kind: "note",
  targetId: "target-1",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  expiresAt: new Date("2026-11-08T00:00:00Z"),
  revokedAt: null,
};

describe("createShareLink", () => {
  it("stores the token's hash, never the token, and returns the token once", async () => {
    const { prisma, statements } = fakeDb([row]);
    const made = await createShareLink(
      prisma,
      actor,
      { kind: "note", targetId: "t", days: 7 },
      kinds(),
    );
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const values = statements[0]!.values.map(String);
    expect(values).not.toContain(made.token);
    expect(values.some((value) => /^[0-9a-f]{64}$/.test(value))).toBe(true);
    expect(made.link).toEqual({
      id: "link-1",
      kind: "note",
      targetId: "target-1",
      createdAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-11-08T00:00:00.000Z",
      revokedAt: null,
    });
  });

  it.each([
    ["an unknown kind", "other", kinds()],
    ["a name only the object prototype has", "constructor", kinds()],
    ["a target the member may not share", "note", kinds({}, false)],
  ])("refuses %s as not found, storing nothing", async (_case, kind, map) => {
    const { prisma, statements } = fakeDb();
    await expect(
      createShareLink(prisma, actor, { kind, targetId: "t", days: 1 }, map),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(statements).toEqual([]);
  });
});

describe("procedures", () => {
  type Handler = (call: { context: { actor: Actor }; input?: unknown }) => Promise<unknown>;
  function routes(prisma: never) {
    const authed = new Proxy(
      {},
      { get: () => new Proxy({}, { get: () => ({ handler: (fn: Handler) => fn }) }) },
    );
    const ctx = { deps: { prisma, env: { webOrigin: "https://app.example.test" } }, authed };
    return dozoShareLinkRoutes(ctx as unknown as RouterContext, kinds())
      .dozoShareLinks as unknown as Record<"create" | "list" | "revoke", Handler>;
  }

  it("answers a new link with its web address, which carries the token", async () => {
    const made = (await routes(fakeDb([row]).prisma).create({
      context: { actor },
      input: { kind: "note", targetId: "t", days: 1 },
    })) as { url: string };
    expect(made.url).toMatch(/^https:\/\/app\.example\.test\/s\/[A-Za-z0-9_-]{43}$/);
  });

  it("lists the member's own links in the Space", async () => {
    const { prisma, statements } = fakeDb([row]);
    const listed = (await routes(prisma).list({ context: { actor } })) as { links: unknown[] };
    expect(listed.links).toHaveLength(1);
    expect(statements[0]!.values).toEqual(expect.arrayContaining(["user-1", "space-1"]));
  });

  it("revokes one of the member's links", async () => {
    const revoked = await routes(fakeDb([{ id: "link-1" }]).prisma).revoke({
      context: { actor },
      input: { id: "link-1" },
    });
    expect(revoked).toEqual({ revoked: true });
  });
});

describe("revokeShareLink", () => {
  it("is not found when no link of the member's matches", async () => {
    const { prisma, statements } = fakeDb([]);
    await expect(revokeShareLink(prisma, actor, "link-1")).rejects.toBeInstanceOf(IsolationError);
    expect(statements[0]!.values).toEqual(["link-1", "user-1", "space-1"]);
  });
});

describe("readSharedLink", () => {
  const live = { userId: "user-1", spaceId: "space-1", kind: "note", targetId: "t" };

  it("never looks up a string that cannot be a token", async () => {
    const { prisma, statements } = fakeDb();
    for (const token of ["", "short", `${TOKEN}A`, `${"A".repeat(42)}/`]) {
      expect(await readSharedLink(prisma, token, kinds())).toBeNull();
    }
    expect(statements).toEqual([]);
  });

  it("asks only for live links, by the token's hash", async () => {
    const { prisma, statements } = fakeDb([]);
    expect(await readSharedLink(prisma, TOKEN, kinds())).toBeNull();
    expect(statements[0]!.text).toContain(
      '"revokedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP',
    );
    expect(statements[0]!.values).not.toContain(TOKEN);
  });

  it("refuses a row whose hash is not the token's", async () => {
    const { prisma } = fakeDb([{ ...live, tokenHash: HASH_OF_TOKEN }]);
    expect(await readSharedLink(prisma, TOKEN, kinds())).toBeNull();
  });

  const tokenHash = createHash("sha256").update(TOKEN).digest("hex");

  it("refuses a link whose kind this server lacks", async () => {
    expect(await readSharedLink(fakeDb([{ ...live, tokenHash }]).prisma, TOKEN, {})).toBeNull();
  });

  it("refuses a link whose target has nothing to show", async () => {
    const { prisma } = fakeDb([{ ...live, tokenHash }]);
    expect(await readSharedLink(prisma, TOKEN, kinds(null))).toBeNull();
  });

  it("gives the kind's payload for the link's own target and maker", async () => {
    const map = kinds({ shown: 1 });
    expect(await readSharedLink(fakeDb([{ ...live, tokenHash }]).prisma, TOKEN, map)).toEqual({
      kind: "note",
      payload: { shown: 1 },
    });
    expect(map.note!.load).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      spaceId: "space-1",
      targetId: "t",
    });
  });
});

describe("signed-out route", () => {
  function server(prisma: never, map: DozoShareKinds, ip = "203.0.113.9") {
    const app = new Hono();
    mountDozoShareLinks(app, prisma, () => ip, map);
    return app;
  }

  it("answers every refusal with the same uncacheable, unindexed 404", async () => {
    const app = server(fakeDb().prisma, kinds());
    const bodies = new Set<string>();
    for (const token of ["nope", TOKEN]) {
      const response = await app.request(`${DOZO_SHARE_LINK_API_PREFIX}${token}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("no-store");
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
  });

  it("serves a live link's kind and payload, unindexed", async () => {
    const tokenHash = createHash("sha256").update(TOKEN).digest("hex");
    const live = { userId: "user-1", spaceId: "space-1", kind: "note", targetId: "t", tokenHash };
    const response = await server(fakeDb([live]).prisma, kinds({ shown: 1 })).request(
      `${DOZO_SHARE_LINK_API_PREFIX}${TOKEN}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.json()).toEqual({ kind: "note", payload: { shown: 1 } });
  });

  it("limits reads per address", async () => {
    const app = server(fakeDb().prisma, kinds());
    let last: Response | undefined;
    for (let i = 0; i <= 120; i++) last = await app.request(`${DOZO_SHARE_LINK_API_PREFIX}nope`);
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toBe("60");
  });
});

describe("feature hub", () => {
  it("answers every procedure of the feature contracts, which the app contract carries", () => {
    const ctx = {
      deps: { prisma: {}, env: { webOrigin: "https://app.example.test" } },
      authed: new Proxy(
        {},
        { get: (_, key) => new Proxy({}, { get: () => ({ handler: () => key }) }) },
      ),
    } as unknown as RouterContext;
    const routes = dozoFeatureRoutes(ctx);
    expect(Object.keys(routes).sort()).toEqual(Object.keys(dozoFeaturesContract).sort());
    for (const [key, procedures] of Object.entries(dozoFeaturesContract)) {
      expect(Object.keys(routes[key as keyof typeof routes]).sort()).toEqual(
        Object.keys(procedures).sort(),
      );
      expect(appContract).toHaveProperty(key);
    }
  });
});
