import type { SecretStore } from "@rakazo/adapter-kit";
import type { UserDeviceHub } from "@rakazo/adapters";
import {
  createDeviceLogin,
  DEVICE_HANDLE,
  deleteDeviceLogin,
  deviceCanLink,
} from "@rakazo/adapters";
import { USER_DEVICE_PATH } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";
import { z } from "zod";
import { readBoundedBody } from "./http-body.js";

/**
 * The routes a computer's desktop app uses to link a login from its password manager into the
 * vault (dozo-device-login.ts): it sends the title, the site and the handle it keeps the link
 * under, and never a value. Authenticated with the computer's own token, like removing itself;
 * what a request may touch is the computer the token names, never one it names itself.
 */
export interface DeviceLoginRouteDeps {
  prisma: PrismaClient;
  hub: Pick<UserDeviceHub, "authenticate">;
  secrets: SecretStore;
}

const BODY_MAX_BYTES = 4096;

function isHttpsOrigin(value: string): boolean {
  return (
    URL.canParse(value) && new URL(value).protocol === "https:" && new URL(value).origin === value
  );
}

const LinkRequest = z.object({
  title: z.string().trim().min(1).max(200),
  origin: z.string().max(300).refine(isHttpsOrigin),
  handle: z.string().regex(DEVICE_HANDLE),
});

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function mountDeviceLoginRoutes(app: Hono, deps: DeviceLoginRouteDeps) {
  const { prisma } = deps;
  const path = `${USER_DEVICE_PATH}/self/dozo-logins`;

  app.post(path, async (c) => {
    const device = await deps.hub.authenticate(c.req.header("authorization"));
    if (!device) return c.json({ error: "Unauthorized" }, 401);
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected JSON" }, 415);
    const body = await readBoundedBody(c.req.raw, BODY_MAX_BYTES);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    const input = LinkRequest.safeParse(parseJson(body));
    if (!input.success) return c.json({ error: "Invalid login" }, 400);
    if (!(await deviceCanLink(prisma, device)))
      return c.json({ error: "This computer does not use a password manager" }, 403);
    try {
      const made = await createDeviceLogin(
        { prisma, secretStore: deps.secrets },
        { id: device.id, userId: device.userId },
        input.data,
      );
      return c.json({ name: made.name }, made.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ClientError && error.kind === "CONFLICT")
        return c.json({ error: error.message }, 409);
      if (error instanceof ClientError && error.kind === "UNAUTHORIZED")
        return c.json({ error: error.message }, 401);
      throw error;
    }
  });

  app.delete(`${path}/:handle`, async (c) => {
    const device = await deps.hub.authenticate(c.req.header("authorization"));
    if (!device) return c.json({ error: "Unauthorized" }, 401);
    const handle = c.req.param("handle");
    if (!DEVICE_HANDLE.test(handle)) return c.json({ error: "Invalid login" }, 400);
    await deleteDeviceLogin(prisma, device.id, handle);
    return c.body(null, 204);
  });
}
