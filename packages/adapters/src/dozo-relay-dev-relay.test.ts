import { createHash } from "node:crypto";
import { once } from "node:events";
import { RELAY_MAX_MESSAGE_BYTES } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { DevRelay } from "./dozo-relay-dev-relay.js";
import { startDevRelay } from "./dozo-relay-dev-relay.js";

let relay: DevRelay;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  relay = await startDevRelay();
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await relay.close();
});

const verifier = (token: string) => createHash("sha256").update(token).digest("base64url");

async function register(overrides: Record<string, unknown> = {}) {
  const response = await fetch(`${relay.url}/v1/channels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostVerifier: verifier("host"),
      pairVerifier: verifier("pair"),
      pairExpiresAt: Date.now() + 60_000,
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { channel: string }).channel;
}

/** Opens a socket and collects its text messages; resolves once open or with the refusal status. */
function open(channel: string, role: "host" | "app", token: string) {
  const socket = new WebSocket(
    `${relay.url.replace("http", "ws")}/v1/channels/${channel}/${role}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  sockets.push(socket);
  const texts: string[] = [];
  const binary: Buffer[] = [];
  socket.on("message", (data: Buffer, isBinary) => {
    if (isBinary) binary.push(data);
    else texts.push(data.toString());
  });
  const ready = new Promise<number>((resolve) => {
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("error", () => resolve(0));
  });
  return { socket, texts, binary, ready };
}

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));

describe("dev relay", () => {
  it("answers 400 to a body that does not parse and 404 to anything unknown", async () => {
    const bad = await fetch(`${relay.url}/v1/channels`, { method: "POST", body: "{" });
    expect(bad.status).toBe(400);
    const wrong = await fetch(`${relay.url}/v1/channels`, { method: "POST", body: "{}" });
    expect(wrong.status).toBe(400);
    expect((await fetch(`${relay.url}/other`)).status).toBe(404);
    const channel = await register();
    const unauthorized = await fetch(`${relay.url}/v1/channels/${channel}/app`, {
      method: "PUT",
      headers: { authorization: "Bearer pair" },
      body: JSON.stringify({ appVerifier: verifier("app") }),
    });
    expect(unauthorized.status).toBe(404);
    const noAuth = await fetch(`${relay.url}/v1/channels/${channel}`, { method: "DELETE" });
    expect(noAuth.status).toBe(404);
    expect(await open(channel, "host", "nope").ready).toBe(404);
    expect(await open("unknown", "host", "host").ready).toBe(404);
  });

  it("pairs two sockets, tells each about the other and forwards binary only", async () => {
    const channel = await register();
    const host = open(channel, "host", "host");
    expect(await host.ready).toBe(101);
    await until(() => host.texts.length === 1);
    expect(JSON.parse(host.texts[0] as string)).toEqual({ type: "peer", present: false });

    const app = open(channel, "app", "pair");
    expect(await app.ready).toBe(101);
    await until(() => app.texts.length === 1 && host.texts.length === 2);
    expect(JSON.parse(app.texts[0] as string)).toEqual({ type: "peer", present: true });
    expect(JSON.parse(host.texts[1] as string)).toEqual({ type: "peer", present: true });

    app.socket.send(Buffer.from([1, 2, 3]));
    app.socket.send("ping");
    app.socket.send("hello");
    await until(() => host.binary.length === 1 && app.texts.length === 2);
    expect([...(host.binary[0] as Buffer)]).toEqual([1, 2, 3]);
    expect(app.texts[1]).toBe("pong");
    expect(relay.seen).toHaveLength(1);

    app.socket.close();
    await until(() => host.texts.length === 3);
    expect(JSON.parse(host.texts[2] as string)).toEqual({ type: "peer", present: false });
    host.socket.send(Buffer.from([9]));
    await until(() => relay.seen.length === 2);
  });

  it("replaces a socket with code 4000 and refuses an oversized message with 1009", async () => {
    const channel = await register();
    const first = open(channel, "host", "host");
    await first.ready;
    const closed = once(first.socket, "close");
    const second = open(channel, "host", "host");
    await second.ready;
    expect((await closed)[0]).toBe(4000);

    const big = once(second.socket, "close");
    second.socket.send(Buffer.alloc(RELAY_MAX_MESSAGE_BYTES + 1));
    expect((await big)[0]).toBe(1009);
  });

  it("sets the app verifier, drops the pairing token and deletes with either token", async () => {
    const channel = await register();
    const set = await fetch(`${relay.url}/v1/channels/${channel}/app`, {
      method: "PUT",
      headers: { authorization: "Bearer host" },
      body: JSON.stringify({ appVerifier: verifier("app") }),
    });
    expect(set.status).toBe(204);
    expect(await open(channel, "app", "pair").ready).toBe(404);
    const app = open(channel, "app", "app");
    expect(await app.ready).toBe(101);
    const bad = await fetch(`${relay.url}/v1/channels/${channel}/app`, {
      method: "PUT",
      headers: { authorization: "Bearer host" },
      body: "[]",
    });
    expect(bad.status).toBe(400);

    const closed = once(app.socket, "close");
    const removed = await fetch(`${relay.url}/v1/channels/${channel}`, {
      method: "DELETE",
      headers: { authorization: "Bearer app" },
    });
    expect(removed.status).toBe(204);
    await closed;
    expect(await open(channel, "host", "host").ready).toBe(404);
  });

  it("refuses the pairing token after it expires", async () => {
    const channel = await register({ pairExpiresAt: Date.now() - 1 });
    expect(await open(channel, "app", "pair").ready).toBe(404);
  });

  it("keeps its channels across a restart on the same port", async () => {
    const channel = await register();
    const { port, state } = relay;
    await relay.close();
    relay = await startDevRelay({ port, state });
    expect(relay.url).toBe(`http://127.0.0.1:${port}`);
    expect(await open(channel, "host", "host").ready).toBe(101);
  });
});
