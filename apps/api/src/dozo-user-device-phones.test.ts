import { UserDeviceHub, UserDevices, userDeviceForwardSecret } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { installSecurityEventStore } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountUserDeviceRoutes } from "./user-devices.js";

// The branded pairing route (dozo/brand/brand.json): one phone per account. Runs on the staged tree.

type Row = {
  id: string;
  userId: string;
  platform: string;
  revokedAt: Date | null;
  revokedBy?: string;
};
type Where = Partial<Row> & { platform?: string | { in: string[] } };

function fakePrisma() {
  const rows: Row[] = [];
  const events: Array<{ type: string; metadata: unknown }> = [];
  const state = { inTransaction: false, revokedInTransaction: false };
  const matches = (row: Row, where: Where) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "in" in value
        ? (value.in as string[]).includes(row[key as keyof Row] as string)
        : row[key as keyof Row] === value,
    );
  const prisma = {
    userDevice: {
      count: async ({ where }: { where: Where }) =>
        rows.filter((row) => matches(row, where)).length,
      create: async ({ data }: { data: Omit<Row, "id" | "revokedAt"> }) => {
        const row = { ...data, id: `device-${rows.length + 1}`, revokedAt: null };
        rows.push(row);
        return { id: row.id };
      },
      findMany: async ({ where }: { where: Where }) => rows.filter((row) => matches(row, where)),
      updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const hit = rows.filter((row) => matches(row, where));
        if (data.revokedAt) state.revokedInTransaction ||= state.inTransaction;
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    userDeviceConnection: { findUnique: async () => null },
    session: { findMany: async () => [] },
    securityEvent: {
      create: async ({ data }: { data: (typeof events)[number] }) => events.push(data),
    },
    $executeRaw: async () => 1,
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      state.inTransaction = true;
      try {
        return await run(prisma);
      } finally {
        state.inTransaction = false;
      }
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows, events, state };
}

const hubs: UserDeviceHub[] = [];

function setup() {
  const db = fakePrisma();
  installSecurityEventStore(db.prisma);
  const hub = new UserDeviceHub({ prisma: db.prisma, address: "http://127.0.0.1:3100" });
  hubs.push(hub);
  const secret = userDeviceForwardSecret("test-key");
  const devices = new UserDevices({ prisma: db.prisma, forwardSecret: secret, hub });
  const disconnectedInTransaction: boolean[] = [];
  const disconnect = vi.spyOn(devices, "disconnect").mockImplementation(async () => {
    disconnectedInTransaction.push(db.state.inTransaction);
  });
  vi.spyOn(devices, "releaseSignedOut").mockResolvedValue();
  const app = new Hono();
  mountUserDeviceRoutes(app, {
    prisma: db.prisma,
    hub,
    devices,
    forwardSecret: secret,
    session: async (request) => {
      const userId = request.headers.get("x-test-user");
      return userId ? { userId, sessionId: `${userId}-session` } : null;
    },
    trustedOrigin: () => true,
  });
  const request = (user: string, platform: string) =>
    app.request("/api/devices/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": user },
      body: JSON.stringify({ name: "Device", platform }),
    });
  const pair = async (user: string, platform: string) => {
    const response = await request(user, platform);
    expect(response.status).toBe(201);
    return ((await response.json()) as { deviceId: string }).deviceId;
  };
  return { ...db, pair, request, disconnect, disconnectedInTransaction };
}

afterEach(async () => {
  installSecurityEventStore(undefined);
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

describe("pairing a phone", () => {
  it("ends the account's previous phone, and only that", async () => {
    const { pair, rows, events, disconnect } = setup();
    const mac = await pair("user-1", "darwin");
    const first = await pair("user-1", "ios");
    const others = await pair("user-2", "android");
    expect(disconnect).not.toHaveBeenCalled();
    const second = await pair("user-1", "android");
    expect(rows.filter((row) => !row.revokedAt).map((row) => row.id)).toEqual([
      mac,
      others,
      second,
    ]);
    expect(rows.find((row) => row.id === first)).toMatchObject({ revokedBy: "owner" });
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(first);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "device.revoked",
        metadata: { deviceId: first, by: "owner" },
      }),
    );
  });

  it("leaves the phone paired when a computer pairs", async () => {
    const { pair, rows, disconnect } = setup();
    await pair("user-1", "ios");
    await pair("user-1", "linux");
    expect(rows.every((row) => !row.revokedAt)).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("ends it under the pairing's lock, and closes its socket only after that commits", async () => {
    const { pair, state, disconnectedInTransaction } = setup();
    await pair("user-1", "ios");
    await pair("user-1", "ios");
    expect(state.revokedInTransaction).toBe(true);
    expect(disconnectedInTransaction).toEqual([false]);
  });
});

describe("the computers' limit", () => {
  it("counts no phone, and never stops a phone pairing", async () => {
    const { pair, request, rows } = setup();
    const phone = await pair("user-1", "android");
    for (let index = 0; index < 10; index += 1) await pair("user-1", "darwin");
    expect((await request("user-1", "linux")).status).toBe(409);
    expect(rows.find((row) => row.id === phone)?.revokedAt).toBeNull();
    const next = await pair("user-1", "ios");
    expect(rows.filter((row) => !row.revokedAt && row.platform !== "darwin")).toEqual([
      expect.objectContaining({ id: next }),
    ]);
  });
});
