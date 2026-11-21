import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  DEVICE_CAPABILITIES_HEADER,
  deviceOffers,
  parseDeviceCapabilities,
} from "./dozo-device-capabilities.js";
import {
  hashUserDeviceToken,
  UserDeviceHub,
  UserDevices,
  userDeviceForwardSecret,
} from "./dozo-user-device-gateway.js";

const TOKEN = "a".repeat(64);

/** One paired device, its connection rows and the fork table, as the hub and gateway use them. */
function fakePrisma() {
  const device = {
    id: "device-1",
    userId: "user-1",
    name: "Laptop",
    platform: "darwin",
    tokenHash: hashUserDeviceToken(TOKEN),
    revokedAt: null,
    revokedBy: null,
    sessionId: null,
  };
  const connections = new Map<string, { deviceId: string; connectedAt: Date }>();
  const capabilities = new Map<string, string[]>();
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const prisma = {
    userDevice: {
      findUnique: async ({ where }: { where: { tokenHash?: string; id?: string } }) =>
        where.tokenHash === device.tokenHash || where.id === device.id ? device : null,
      update: async () => device,
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [],
    },
    userDeviceConnection: {
      upsert: async ({ create }: { create: { deviceId: string; connectedAt: Date } }) =>
        connections.set(create.deviceId, create),
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => {
        connections.clear();
        return { count: 0 };
      },
      findFirst: async () => {
        const row = connections.get(device.id);
        return row
          ? {
              ...row,
              connectionId: "c",
              address: "http://unused",
              device: { name: device.name, platform: device.platform },
            }
          : null;
      },
    },
    session: {
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.map((userId) => ({ userId })),
    },
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(prisma),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.includes("INSERT INTO dozo_device_capabilities"))
        capabilities.set(values[0] as string, values[1] as string[]);
      else if (text.includes("DELETE FROM dozo_device_capabilities"))
        capabilities.delete(values[0] as string);
      else throw new Error(`unexpected SQL: ${text}`);
      return 1;
    }),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const declared = capabilities.get(values[0] as string);
      if (!sql(strings).includes("FROM dozo_device_capabilities")) throw new Error("unexpected");
      return declared ? [{ capabilities: declared }] : [];
    },
  };
  return { prisma: prisma as unknown as PrismaClient, capabilities, connections };
}

async function serve(hub: UserDeviceHub) {
  const server = createServer();
  server.on("upgrade", hub.handleUpgrade);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    async connect(headers: Record<string, string>, path = USER_DEVICE_CONNECT_PATH) {
      const ws = new WebSocket(`${base}${path}`, { headers });
      ws.on("error", () => undefined);
      const opened = await Promise.race([
        once(ws, "open").then(() => true),
        once(ws, "unexpected-response").then(() => false),
      ]);
      return { ws, opened };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await hub.close();
    },
  };
}

describe("parseDeviceCapabilities", () => {
  it("keeps the known capabilities once each, and tells an absent header from an empty one", () => {
    expect(parseDeviceCapabilities(undefined)).toBeNull();
    expect(parseDeviceCapabilities("")).toEqual([]);
    expect(parseDeviceCapabilities(" Shell , teleport,shell")).toEqual(["shell"]);
    expect(parseDeviceCapabilities(["screen", "shell"])).toEqual(["shell", "screen"]);
  });
});

describe("deviceOffers", () => {
  it("holds a computer from the hub to what it declared", () => {
    const base = { deviceId: "d", name: "Mac", platform: "darwin" };
    expect(deviceOffers({ ...base, capabilities: ["shell"] })).toEqual({
      shell: true,
      screen: false,
    });
    expect(deviceOffers({ ...base, capabilities: ["shell", "screen"] })).toEqual({
      shell: true,
      screen: true,
    });
    expect(deviceOffers({ ...base, platform: "linux", capabilities: ["screen"] })).toEqual({
      shell: false,
      screen: true,
    });
  });

  it("offers a computer that did not come through the hub upstream's commands and no screen", () => {
    expect(deviceOffers({ deviceId: "d", name: "Mac", platform: "darwin" })).toEqual({
      shell: true,
      screen: false,
    });
    expect(
      deviceOffers({ deviceId: "d", name: "This", platform: "linux", screenOnly: true }),
    ).toEqual({ shell: false, screen: false });
  });
});

describe("a connecting computer's declaration", () => {
  function setup() {
    const db = fakePrisma();
    const hub = new UserDeviceHub({ prisma: db.prisma, address: "http://api-1" });
    const devices = new UserDevices({
      prisma: db.prisma,
      forwardSecret: userDeviceForwardSecret("k"),
      hub,
    });
    return { ...db, hub, devices };
  }

  it("is saved before the connection is taken, and offered to the next run", async () => {
    const { hub, devices } = setup();
    const server = await serve(hub);
    try {
      const { ws, opened } = await server.connect({
        authorization: `Bearer ${TOKEN}`,
        [DEVICE_CAPABILITIES_HEADER]: "shell,screen",
      });
      expect(opened).toBe(true);
      await vi.waitFor(async () => expect(await devices.connected("user-1")).not.toBeNull());
      const device = await devices.connected("user-1");
      expect(device?.capabilities).toEqual(["shell", "screen"]);
      expect(deviceOffers(device!)).toEqual({ shell: true, screen: true });
      ws.close();
    } finally {
      await server.close();
    }
  });

  it("is forgotten when the same computer connects again with an app that declares nothing", async () => {
    const { hub, devices, capabilities } = setup();
    capabilities.set("device-1", ["shell", "screen"]);
    const server = await serve(hub);
    try {
      const { ws, opened } = await server.connect({ authorization: `Bearer ${TOKEN}` });
      expect(opened).toBe(true);
      await vi.waitFor(async () => expect(await devices.connected("user-1")).not.toBeNull());
      const device = await devices.connected("user-1");
      expect(device?.capabilities).toEqual(["shell"]);
      // Older desktop apps (0.3.0, 0.4.0) send no header: commands only, no screen tools.
      expect(deviceOffers(device!)).toEqual({ shell: true, screen: false });
      ws.close();
    } finally {
      await server.close();
    }
  });

  it("saves nothing for a token that does not authenticate or another path", async () => {
    const { hub, prisma } = setup();
    const server = await serve(hub);
    try {
      const refused = await server.connect({
        authorization: `Bearer ${"b".repeat(64)}`,
        [DEVICE_CAPABILITIES_HEADER]: "shell,screen",
      });
      expect(refused.opened).toBe(false);
      const elsewhere = await server.connect(
        { authorization: `Bearer ${TOKEN}`, [DEVICE_CAPABILITIES_HEADER]: "screen" },
        "/other",
      );
      expect(elsewhere.opened).toBe(false);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("still lets the computer connect when the save fails", async () => {
    const { hub, devices, prisma } = setup();
    vi.mocked(prisma.$executeRaw).mockRejectedValueOnce(new Error("database restarting"));
    const server = await serve(hub);
    try {
      const { ws, opened } = await server.connect({
        authorization: `Bearer ${TOKEN}`,
        [DEVICE_CAPABILITIES_HEADER]: "shell,screen",
      });
      expect(opened).toBe(true);
      await vi.waitFor(async () => expect(await devices.connected("user-1")).not.toBeNull());
      expect((await devices.connected("user-1"))?.capabilities).toEqual(["shell"]);
      ws.close();
    } finally {
      await server.close();
    }
  });

  it("survives a client reset while it saves, and then hands the socket on", async () => {
    const { hub } = setup();
    const lookup = deferred<null>();
    vi.spyOn(hub, "authenticate").mockReturnValueOnce(lookup.promise);
    const socket = Object.assign(new EventEmitter(), { end: vi.fn() });
    hub.handleUpgrade(
      {
        url: USER_DEVICE_CONNECT_PATH,
        headers: { authorization: `Bearer ${"b".repeat(64)}` },
      } as never,
      socket as never,
      Buffer.alloc(0),
    );
    // Without a listener an "error" event throws, which would crash the process.
    expect(() => socket.emit("error", new Error("reset"))).not.toThrow();
    lookup.resolve(null);
    await vi.waitFor(() =>
      expect(socket.end).toHaveBeenCalledWith(expect.stringMatching(/^HTTP\/1.1 401 /)),
    );
    // A request with no path is upstream's to refuse; nothing is looked up for it.
    const bare = Object.assign(new EventEmitter(), { end: vi.fn() });
    hub.handleUpgrade({ headers: {} } as never, bare as never, Buffer.alloc(0));
    await vi.waitFor(() =>
      expect(bare.end).toHaveBeenCalledWith(expect.stringMatching(/^HTTP\/1.1 404 /)),
    );
    expect(hub.authenticate).toHaveBeenCalledOnce();
    await hub.close();
  });

  it("has no computer for a user with none connected", async () => {
    const { devices, hub } = setup();
    await expect(devices.connected("user-1")).resolves.toBeNull();
    await hub.close();
  });
});
