import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { DeclaredUserDevice } from "./dozo-device-capabilities.js";
import {
  DEVICE_CAPABILITIES_HEADER,
  parseDeviceCapabilities,
  readDeviceCapabilities,
  recordDeviceCapabilities,
} from "./dozo-device-capabilities.js";
import {
  UserDeviceHub as UpstreamUserDeviceHub,
  UserDevices as UpstreamUserDevices,
} from "./user-device-gateway.js";

export * from "./user-device-gateway.js";

/**
 * Upstream's hub, which also saves what a connecting computer declares
 * (dozo-device-capabilities.ts) before the connection is taken, so the first run after it sees it.
 */
export class UserDeviceHub extends UpstreamUserDeviceHub {
  private readonly prisma: PrismaClient;
  private readonly upstreamUpgrade = this.handleUpgrade;

  constructor(deps: ConstructorParameters<typeof UpstreamUserDeviceHub>[0]) {
    super(deps);
    this.prisma = deps.prisma;
  }

  override handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Until upstream's handler takes the socket, a client reset must not crash the process.
    const onError = (error: Error) =>
      getLogger().warn("user device upgrade socket error", { error });
    socket.on("error", onError);
    // A database that cannot save it cannot record the connection either: upstream refuses it.
    void bestEffort("save a user device's capabilities", this.declare(request)).then(() => {
      socket.off("error", onError);
      this.upstreamUpgrade(request, socket, head);
    });
  };

  /** A token that does not authenticate saves nothing; upstream's handler refuses it. */
  private async declare(request: IncomingMessage) {
    if (new URL(request.url ?? "/", "http://device").pathname !== USER_DEVICE_CONNECT_PATH) return;
    const device = await this.authenticate(request.headers.authorization);
    if (!device) return;
    await recordDeviceCapabilities(
      this.prisma,
      device.id,
      parseDeviceCapabilities(request.headers[DEVICE_CAPABILITIES_HEADER]),
    );
  }
}

/** Upstream's gateway, whose connected computer carries what it declared. */
export class UserDevices extends UpstreamUserDevices {
  private readonly prisma: PrismaClient;

  constructor(deps: ConstructorParameters<typeof UpstreamUserDevices>[0]) {
    super(deps);
    this.prisma = deps.prisma;
  }

  override async connected(userId: string): Promise<DeclaredUserDevice | null> {
    const device = await super.connected(userId);
    if (!device) return null;
    return { ...device, capabilities: await readDeviceCapabilities(this.prisma, device.deviceId) };
  }
}
