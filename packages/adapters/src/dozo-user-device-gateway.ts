import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { UserDeviceSummary } from "@rakazo/contracts";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { DeclaredUserDevice, DeviceCapability } from "./dozo-device-capabilities.js";
import {
  DEVICE_CAPABILITIES_HEADER,
  parseDeviceCapabilities,
  readCapabilitySince,
  readDeviceCapabilities,
  recordDeviceCapabilities,
} from "./dozo-device-capabilities.js";
import { isPhonePlatform, PHONE_PLATFORMS } from "./dozo-phone-protocol.js";
import {
  UserDeviceHub as UpstreamUserDeviceHub,
  UserDevices as UpstreamUserDevices,
} from "./user-device-gateway.js";

export { isPhonePlatform, PHONE_PLATFORMS } from "./dozo-phone-protocol.js";
export * from "./user-device-gateway.js";

/** Upstream's window: a connection row whose heartbeat is older lost its holding process. */
const STALE_AFTER_MS = 75_000;
const live = () => ({ gt: new Date(Date.now() - STALE_AFTER_MS) });
const phones = [...PHONE_PLATFORMS];

/** The user's connected phone that declared a capability, and when it was paired. */
export interface ConnectedPhone {
  deviceId: string;
  pairedAt: Date;
  /** Since when that capability has been on, on this pairing: no consent from before it counts. */
  onSince: Date;
}

/**
 * The way to the user's phone of a gateway another wraps (the desktop server adds its own computer
 * around it, host-computer-device.ts), so the wrapper keeps it; nothing when the gateway has none.
 */
export function phoneReach(
  devices: object | undefined,
): Partial<Pick<UserDevices, "connectedPhone">> {
  if (!(devices instanceof UserDevices)) return {};
  return { connectedPhone: (userId, capability) => devices.connectedPhone(userId, capability) };
}

/**
 * Upstream's hub, which also saves what a connecting device declares
 * (dozo-device-capabilities.ts) before the connection is taken, so the first run after it sees it.
 * A computer whose declaration cannot be saved still connects, on what it declared before. A phone
 * does not: it offers only what it declared on this connection, so an older "calendar" never
 * outlives a switch turned off while the database was away.
 */
export class UserDeviceHub extends UpstreamUserDeviceHub {
  private readonly prisma: PrismaClient;

  constructor(deps: ConstructorParameters<typeof UpstreamUserDeviceHub>[0]) {
    super(deps);
    this.prisma = deps.prisma;
    const upstream = this.handleUpgrade;
    this.handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Until upstream's handler takes the socket, a client reset must not crash the process.
      const onError = (error: Error) =>
        getLogger().warn("user device upgrade socket error", { error });
      socket.on("error", onError);
      void this.declare(request).then((declared) => {
        socket.off("error", onError);
        if (declared) upstream(request, socket, head);
        else
          socket.end(
            "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
      });
    };
  }

  /**
   * Saves what the device declared; false only for a phone whose declaration was not saved. A
   * token that does not authenticate saves nothing, and upstream's handler refuses it.
   */
  private async declare(request: IncomingMessage): Promise<boolean> {
    if (new URL(request.url ?? "/", "http://device").pathname !== USER_DEVICE_CONNECT_PATH)
      return true;
    // A database that cannot read the token cannot record the connection either: upstream refuses it.
    const device = await bestEffort(
      "find a connecting user device",
      this.authenticate(request.headers.authorization),
    );
    if (!device) return true;
    const saved = await bestEffort(
      "save a user device's capabilities",
      recordDeviceCapabilities(
        this.prisma,
        device.id,
        parseDeviceCapabilities(request.headers[DEVICE_CAPABILITIES_HEADER]),
      ).then(() => true),
    );
    return saved === true || !isPhonePlatform(device.platform);
  }
}

/**
 * Upstream's gateway, whose connected computer carries what it declared. A phone pairs and
 * connects as a device too, but is not a computer: the computer's tools, its approval ("removing
 * every computer ends it") and the Computers list never see it. A run reaches it only through
 * `connectedPhone` (dozo-phone.ts), always by its device id.
 */
export class UserDevices extends UpstreamUserDevices {
  private readonly prisma: PrismaClient;

  constructor(deps: ConstructorParameters<typeof UpstreamUserDevices>[0]) {
    super(deps);
    this.prisma = deps.prisma;
  }

  /** The newest connected computer, as upstream picks it among every device, phones left out. */
  override async connected(userId: string): Promise<DeclaredUserDevice | null> {
    const connection = await runAsSystem("find a user's connected computer", () =>
      this.prisma.userDeviceConnection.findFirst({
        where: {
          heartbeatAt: live(),
          device: { userId, revokedAt: null, platform: { notIn: phones } },
        },
        orderBy: { connectedAt: "desc" },
        include: { device: { select: { name: true, platform: true } } },
      }),
    );
    if (!connection) return null;
    const { deviceId, device } = connection;
    return {
      deviceId,
      name: device.name,
      platform: device.platform,
      capabilities: await readDeviceCapabilities(this.prisma, deviceId, device.platform),
    };
  }

  /** The user's paired computers; a phone is removed from the phone itself. */
  override async list(userId: string): Promise<UserDeviceSummary[]> {
    const devices = await runAsSystem("list a user's devices", () =>
      this.prisma.userDevice.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          platform: true,
          connections: { where: { heartbeatAt: live() }, select: { deviceId: true } },
        },
      }),
    );
    return devices
      .filter((device) => !isPhonePlatform(device.platform))
      .map((device) => ({
        deviceId: device.id,
        name: device.name,
        connected: device.connections.length > 0,
      }));
  }

  /** When the oldest computer still paired was paired: a phone keeps no computer's approval. */
  override async pairedSince(userId: string): Promise<Date | null> {
    const devices = await runAsSystem("find a user's paired device", () =>
      this.prisma.userDevice.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, platform: true },
      }),
    );
    return devices.find((device) => !isPhonePlatform(device.platform))?.createdAt ?? null;
  }

  /** The user's newest connected phone that declared this capability, or null. */
  async connectedPhone(
    userId: string,
    capability: DeviceCapability,
  ): Promise<ConnectedPhone | null> {
    const connections = await runAsSystem("find a user's connected phone", () =>
      this.prisma.userDeviceConnection.findMany({
        where: {
          heartbeatAt: live(),
          device: { userId, revokedAt: null, platform: { in: phones } },
        },
        orderBy: { connectedAt: "desc" },
        include: { device: { select: { platform: true, createdAt: true } } },
      }),
    );
    for (const { deviceId, device } of connections) {
      const declared = await readDeviceCapabilities(this.prisma, deviceId, device.platform);
      if (!declared.includes(capability)) continue;
      const since = await readCapabilitySince(this.prisma, deviceId, capability);
      const pairedAt = device.createdAt;
      return { deviceId, pairedAt, onSince: since && since > pairedAt ? since : pairedAt };
    }
    return null;
  }
}
