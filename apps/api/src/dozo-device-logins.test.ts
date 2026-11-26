import type * as Adapters from "@rakazo/adapters";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  can: vi.fn(),
}));
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  createDeviceLogin: store.create,
  deleteDeviceLogin: store.remove,
  deviceCanLink: store.can,
}));

import { mountDeviceLoginRoutes } from "./dozo-device-logins.js";
import { mountUserDeviceRoutes } from "./auth/user-devices.js";

const HANDLE = "AbCdEfGhIjKlMnOpQrStUv";
const PATH = "/api/devices/self/dozo-logins";
const prisma = {} as PrismaClient;
const secrets = { id: "secrets" };
const body = { title: "My Bank", origin: "https://bank.example.test", handle: HANDLE };

function app(
  device: { id: string; userId: string; platform: string } | null = {
    id: "device-1",
    userId: "user-1",
    platform: "darwin",
  },
) {
  const hono = new Hono();
  const authenticate = vi.fn(async (header: string | null | undefined) =>
    header === "Bearer good" ? device : null,
  );
  mountDeviceLoginRoutes(hono, {
    prisma,
    hub: { authenticate } as never,
    secrets: secrets as never,
  });
  const post = (payload: unknown, headers: Record<string, string> = {}) =>
    hono.request(PATH, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json", ...headers },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  const del = (
    handle: string,
    headers: Record<string, string> = { authorization: "Bearer good" },
  ) => hono.request(`${PATH}/${handle}`, { method: "DELETE", headers });
  return { hono, post, del, authenticate };
}

beforeEach(() => {
  store.create.mockReset().mockResolvedValue({ name: "my-bank", created: true });
  store.remove.mockReset().mockResolvedValue(true);
  store.can.mockReset().mockResolvedValue(true);
});

describe("mounted with the device routes", () => {
  function mounted(withSecrets: boolean) {
    const hono = new Hono();
    mountUserDeviceRoutes(hono, {
      prisma,
      hub: { authenticate: async () => null } as never,
      devices: {} as never,
      forwardSecret: "x".repeat(32),
      pairingSecret: "test-pairing-secret",
      ...(withSecrets ? { secrets: secrets as never } : {}),
      session: async () => null,
      trustedOrigin: () => false,
    });
    return hono;
  }
  const post = (hono: Hono) =>
    hono.request(PATH, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

  it("answers a request with no token where the vault can seal its items, and has no route otherwise", async () => {
    expect((await post(mounted(true))).status).toBe(401);
    expect((await post(mounted(false))).status).toBe(404);
  });

  it("keeps removing the computer itself where it was", async () => {
    const response = await mounted(true).request("/api/devices/self", { method: "DELETE" });
    expect(response.status).toBe(401);
  });
});

describe("POST /api/devices/self/dozo-logins", () => {
  it("links a login for the computer its token names, and answers its name", async () => {
    const { post, authenticate } = app();
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ name: "my-bank" });
    expect(authenticate).toHaveBeenCalledWith("Bearer good");
    expect(store.create).toHaveBeenCalledWith(
      { prisma, secretStore: secrets },
      { id: "device-1", userId: "user-1" },
      body,
    );
    expect(store.can).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ id: "device-1", platform: "darwin" }),
    );
  });

  it("takes the computer from the token alone, never from the body", async () => {
    const { post } = app();
    await post({ ...body, deviceId: "device-2", userId: "user-2" });
    expect(store.create.mock.calls[0]![1]).toEqual({ id: "device-1", userId: "user-1" });
    expect(store.create.mock.calls[0]![2]).toEqual(body);
  });

  it("answers a handle it already holds as it did, with 200", async () => {
    store.create.mockResolvedValue({ name: "my-bank", created: false });
    const response = await app().post(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "my-bank" });
  });

  it("is for a computer's own token only", async () => {
    const { post } = app();
    for (const headers of [{ authorization: "Bearer bad" }, { authorization: "" }]) {
      expect((await post(body, headers)).status).toBe(401);
    }
    expect((await app(null).post(body)).status).toBe(401);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("is for a computer that declared passwords, and never a phone", async () => {
    store.can.mockResolvedValue(false);
    const response = await app({ id: "phone-1", userId: "user-1", platform: "ios" }).post(body);
    expect(response.status).toBe(403);
    expect(store.can).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ id: "phone-1", platform: "ios" }),
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it.each([
    ["no title", { ...body, title: "  " }],
    ["a title that is too long", { ...body, title: "x".repeat(201) }],
    ["an address that is not https", { ...body, origin: "http://bank.example.test" }],
    ["an address with a path", { ...body, origin: "https://bank.example.test/in" }],
    ["something that is not an address", { ...body, origin: "bank" }],
    ["a short handle", { ...body, handle: "short" }],
    ["a handle with other characters", { ...body, handle: "AbCdEfGhIjKlMnOpQrSt!!" }],
    ["no handle", { title: body.title, origin: body.origin }],
    ["not an object", [1]],
  ])("refuses %s", async (_name, payload) => {
    const response = await app().post(payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid login" });
    expect(store.create).not.toHaveBeenCalled();
  });

  it("refuses what is not JSON, and a body that is too large", async () => {
    const { post } = app();
    expect((await post("{not json")).status).toBe(400);
    expect((await post(body, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(JSON.stringify({ ...body, title: "x".repeat(5000) }))).status).toBe(413);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("tells the computer a full vault is a conflict, and a revoked computer it is signed out", async () => {
    store.create.mockRejectedValueOnce(new ClientError("CONFLICT", "Credential limit reached"));
    const full = await app().post(body);
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "Credential limit reached" });
    store.create.mockRejectedValueOnce(
      new ClientError("UNAUTHORIZED", "This computer is not connected to the account"),
    );
    expect((await app().post(body)).status).toBe(401);
  });

  it("lets any other failure be a server error", async () => {
    store.create.mockRejectedValueOnce(new Error("database down"));
    const hono = app().hono;
    hono.onError((_error, c) => c.text("Internal Server Error", 500));
    const response = await hono.request(PATH, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(500);
  });
});

describe("DELETE /api/devices/self/dozo-logins/:handle", () => {
  it("removes the login the computer linked under that handle", async () => {
    const response = await app().del(HANDLE);
    expect(response.status).toBe(204);
    expect(store.remove).toHaveBeenCalledWith(prisma, "device-1", HANDLE);
  });

  it("answers the same when there was nothing to remove, or it was another computer's", async () => {
    store.remove.mockResolvedValue(false);
    expect((await app().del(HANDLE)).status).toBe(204);
  });

  it("asks nothing of a computer that no longer declares passwords", async () => {
    store.can.mockResolvedValue(false);
    expect((await app().del(HANDLE)).status).toBe(204);
    expect(store.can).not.toHaveBeenCalled();
  });

  it("is for a computer's own token only, and for a handle", async () => {
    expect((await app().del(HANDLE, { authorization: "Bearer bad" })).status).toBe(401);
    expect((await app().del("short")).status).toBe(400);
    expect(store.remove).not.toHaveBeenCalled();
  });
});
