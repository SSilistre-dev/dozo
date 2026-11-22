import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { deviceOffers, readDeviceCapabilities } from "./dozo-device-capabilities.js";
import { phoneRoute } from "./dozo-phone.js";
import { UserDevices, userDeviceForwardSecret } from "./dozo-user-device-gateway.js";
import { withHostComputerScreen } from "./host-computer-device.js";
import type { RunContext } from "./run-context.js";

type Device = {
  id: string;
  userId: string;
  name: string;
  platform: string;
  createdAt: Date;
  revokedAt: Date | null;
};
type Where = {
  userId?: string;
  revokedAt?: null;
  platform?: { in?: string[]; notIn?: string[] };
};

/** Paired devices, their connections and what each declared, filtered as Postgres would. */
function fakePrisma() {
  const devices: Device[] = [];
  const connections = new Map<string, { connectedAt: Date; heartbeatAt: Date }>();
  const capabilities = new Map<string, string[]>();
  const matches = (device: Device, where: Where = {}) =>
    (where.userId === undefined || device.userId === where.userId) &&
    (where.revokedAt !== null || device.revokedAt === null) &&
    (!where.platform?.in || where.platform.in.includes(device.platform)) &&
    !where.platform?.notIn?.includes(device.platform);
  const live = (where: { heartbeatAt: { gt: Date }; device: Where }) =>
    [...connections]
      .filter(([, row]) => row.heartbeatAt > where.heartbeatAt.gt)
      .map(([deviceId, row]) => ({
        deviceId,
        ...row,
        device: devices.find((d) => d.id === deviceId)!,
      }))
      .filter((row) => matches(row.device, where.device))
      .sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime());
  const prisma = {
    userDevice: {
      findMany: async ({ where, orderBy }: { where: Where; orderBy: { createdAt: string } }) =>
        devices
          .filter((device) => matches(device, where))
          .sort((a, b) =>
            orderBy.createdAt === "asc"
              ? a.createdAt.getTime() - b.createdAt.getTime()
              : b.createdAt.getTime() - a.createdAt.getTime(),
          )
          .map((device) => ({
            ...device,
            connections: connections.has(device.id) ? [{ deviceId: device.id }] : [],
          })),
    },
    userDeviceConnection: {
      findFirst: async ({ where }: { where: Parameters<typeof live>[0] }) => live(where)[0] ?? null,
      findMany: async ({ where }: { where: Parameters<typeof live>[0] }) => live(where),
    },
    $queryRaw: async (_strings: TemplateStringsArray, deviceId: string) => {
      const declared = capabilities.get(deviceId);
      return declared ? [{ capabilities: declared }] : [];
    },
  };
  let clock = Date.parse("2026-11-01T00:00:00Z");
  const pair = (id: string, platform: string, userId = "user-1") => {
    clock += 60_000;
    devices.push({ id, userId, name: id, platform, createdAt: new Date(clock), revokedAt: null });
  };
  const connect = (id: string, declared?: string[]) => {
    clock += 1_000;
    connections.set(id, { connectedAt: new Date(clock), heartbeatAt: new Date() });
    if (declared) capabilities.set(id, declared);
  };
  const gateway = new UserDevices({
    prisma: prisma as unknown as PrismaClient,
    forwardSecret: userDeviceForwardSecret("k"),
  });
  return { prisma: prisma as unknown as PrismaClient, devices, pair, connect, gateway };
}

describe("a phone among the user's devices", () => {
  it("is never the computer, even when it connected after the desktop", async () => {
    const { pair, connect, gateway } = fakePrisma();
    pair("mac", "darwin");
    pair("phone", "ios");
    connect("mac", ["shell", "screen"]);
    connect("phone", ["calendar"]);
    expect(await gateway.connected("user-1")).toEqual({
      deviceId: "mac",
      name: "mac",
      platform: "darwin",
      capabilities: ["shell", "screen"],
    });
  });

  it("leaves no computer when only a phone is connected", async () => {
    const { pair, connect, gateway } = fakePrisma();
    pair("phone", "android");
    connect("phone", ["calendar"]);
    expect(await gateway.connected("user-1")).toBeNull();
  });

  it("keeps no computer's approval: pairedSince counts computers only", async () => {
    const { pair, devices, gateway } = fakePrisma();
    pair("phone", "ios");
    expect(await gateway.pairedSince("user-1")).toBeNull();
    pair("mac", "darwin");
    expect(await gateway.pairedSince("user-1")).toEqual(devices[1]!.createdAt);
  });

  it("is not listed among the computers", async () => {
    const { pair, connect, gateway } = fakePrisma();
    pair("mac", "darwin");
    pair("phone", "ios");
    connect("phone", ["calendar"]);
    expect(await gateway.list("user-1")).toEqual([
      { deviceId: "mac", name: "mac", connected: false },
    ]);
  });

  it("is the phone a run reads, only while connected and declaring what it is asked for", async () => {
    const { pair, connect, devices, gateway } = fakePrisma();
    pair("mac", "darwin");
    connect("mac", ["shell", "calendar"]);
    // A computer that declares a calendar is still no phone.
    expect(await gateway.connectedPhone("user-1", "calendar")).toBeNull();
    pair("phone", "ios");
    expect(await gateway.connectedPhone("user-1", "calendar")).toBeNull();
    connect("phone", []);
    expect(await gateway.connectedPhone("user-1", "calendar")).toBeNull();
    connect("phone", ["calendar"]);
    expect(await gateway.connectedPhone("user-1", "calendar")).toEqual({
      deviceId: "phone",
      pairedAt: devices[1]!.createdAt,
    });
    expect(await gateway.connectedPhone("user-2", "calendar")).toBeNull();
    devices[1]!.revokedAt = new Date();
    expect(await gateway.connectedPhone("user-1", "calendar")).toBeNull();
  });
});

describe("on the desktop app's own server", () => {
  it("still reaches the user's phone through the gateway that adds this computer", async () => {
    const { pair, connect, gateway } = fakePrisma();
    pair("phone", "ios");
    connect("phone", ["calendar"]);
    const wrapped = withHostComputerScreen(gateway, {
      prisma: {} as PrismaClient,
      sandboxKind: "docker",
      url: "http://127.0.0.1:9",
      token: "t",
    });
    expect(wrapped).not.toBe(gateway);
    const ctx = {
      source: { userComputerOwner: "user-1" },
      deps: { userDevices: wrapped },
    } as unknown as RunContext;
    expect(await phoneRoute(ctx)).toMatchObject({ deviceId: "phone", owner: "user-1" });
  });
});

describe("what a phone declares", () => {
  it("is nothing without a row, and never a computer's capability", async () => {
    const { prisma, pair, connect } = fakePrisma();
    pair("phone", "ios");
    expect(await readDeviceCapabilities(prisma, "phone", "ios")).toEqual([]);
    connect("phone", ["shell", "screen", "browser", "calendar"]);
    expect(await readDeviceCapabilities(prisma, "phone", "ios")).toEqual(["calendar"]);
    // A computer keeps upstream's default and never offers a calendar.
    expect(await readDeviceCapabilities(prisma, "mac", "darwin")).toEqual(["shell"]);
    expect(await readDeviceCapabilities(prisma, "phone", "darwin")).toEqual([
      "shell",
      "screen",
      "browser",
    ]);
  });

  it("offers none of the computer's tools, whatever it declares", () => {
    const phone = { deviceId: "p", name: "Phone", platform: "android" };
    expect(deviceOffers({ ...phone, capabilities: ["shell", "screen", "browser"] })).toEqual({
      shell: false,
      screen: false,
      browser: false,
    });
    expect(deviceOffers(phone)).toEqual({ shell: false, screen: false, browser: false });
  });
});
