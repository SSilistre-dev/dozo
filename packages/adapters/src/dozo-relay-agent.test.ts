import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RelayChannel, RelayKeyPair } from "@rakazo/core";
import {
  decodeRelayBytes,
  encodeRelayBytes,
  openAppChannel,
  parseRelayPairingOffer,
  RelayHttpError,
  relayAppToken,
  relayClient,
  relayPairingSecrets,
  webRelayCrypto,
  wsDuplex,
} from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectRelaySocket,
  defaultRelayStateDir,
  relayAgentMain,
  relayAgentProcess,
} from "./dozo-relay-agent.js";
import type { DevRelay } from "./dozo-relay-dev-relay.js";
import { startDevRelay } from "./dozo-relay-dev-relay.js";

const crypto = webRelayCrypto();
const REQUEST_MARKER = "request-marker-7c1f";
const RESPONSE_MARKER = "response-marker-93ad";

/** The user's Dozo server on loopback: JSON, an echo, a slow answer and a server-sent event stream. */
async function localServer() {
  const events: ((line: string) => void)[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/json") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ ok: true, marker: RESPONSE_MARKER, cookie: request.headers.cookie }),
      );
      return;
    }
    if (url.pathname === "/echo") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => response.end(Buffer.concat(chunks)));
      return;
    }
    if (url.pathname === "/slow") {
      const index = Number(url.searchParams.get("i"));
      setTimeout(() => response.end(String(index)), (index % 5) * 15);
      return;
    }
    if (url.pathname === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write("data: first\n\n");
      events.push((line) => response.write(`data: ${line}\n\n`));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    push: (line: string) => {
      for (const send of events) send(line);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

type Agent = {
  lines: Record<string, unknown>[];
  stop(): Promise<number>;
};

let stateDir: string;
let relay: DevRelay;
let local: Awaited<ReturnType<typeof localServer>>;
const cleanups: (() => unknown)[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "dozo-relay-agent-"));
  relay = await startDevRelay();
  local = await localServer();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await relay.close();
  await local.close();
  await rm(stateDir, { recursive: true, force: true });
});

async function cli(args: string[], extra: { now?: () => number; signal?: AbortSignal } = {}) {
  const lines: Record<string, unknown>[] = [];
  const code = await relayAgentMain([...args, "--state", stateDir], {
    write: (line) => lines.push(JSON.parse(line)),
    signal: extra.signal ?? new AbortController().signal,
    stateDir: "/nonexistent",
    random: () => 0,
    now: extra.now,
  });
  return { code, lines };
}

function runAgent(): Agent {
  const controller = new AbortController();
  const lines: Record<string, unknown>[] = [];
  const finished = relayAgentMain(["run", "--origin", local.origin], {
    write: (line) => lines.push(JSON.parse(line)),
    stateDir,
    signal: controller.signal,
    random: () => 0,
  });
  const agent = {
    lines,
    stop: async () => {
      controller.abort();
      return finished;
    },
  };
  cleanups.push(() => agent.stop());
  return agent;
}

/** The offer inside the QR code's link. */
function offerOf(qr: string) {
  expect(qr.startsWith("rakazo://dozo-pair#")).toBe(true);
  return qr.slice(qr.indexOf("#") + 1);
}

async function pairOffer() {
  const { code, lines } = await cli(["pair", "--relay", relay.url]);
  expect(code).toBe(0);
  return lines[0] as { event: string; channel: string; qr: string; expiresAt: number };
}

const ws = (base: string) => base.replace(/^http/, "ws");

/** The phone's side: one socket, one sealed session, and the fetch it carries. */
async function phone(options: {
  channel: string;
  token: string;
  psk: Uint8Array;
  appKey: RelayKeyPair;
  hostKey: Uint8Array;
}) {
  const socket = await connectRelaySocket(
    `${ws(relay.url)}/v1/channels/${options.channel}/app`,
    options.token,
    new AbortController().signal,
  );
  const sealed = await new Promise<RelayChannel>((resolve, reject) => {
    wsDuplex(socket, {
      role: "app",
      onSession: (transport) => {
        openAppChannel({ crypto, transport, ...options }).then(resolve, reject);
      },
    });
  });
  const client = relayClient(sealed);
  cleanups.push(() => client.close());
  cleanups.push(() => socket.close());
  return { client, sealed, socket };
}

/** Pairs a phone through the QR text and returns what it stores afterwards. */
async function pairPhone(agent: Agent) {
  const offerLine = await pairOffer();
  await vi.waitFor(() =>
    expect(agent.lines).toContainEqual({ event: "connected", channel: offerLine.channel }),
  );
  const offer = parseRelayPairingOffer(offerOf(offerLine.qr), Date.now());
  const { psk, token } = await relayPairingSecrets(crypto, decodeRelayBytes(offer.secret));
  const appKey = await crypto.generateKeyPair();
  const hostKey = decodeRelayBytes(offer.hostKey);
  const first = await phone({ channel: offer.channel, token, psk, appKey, hostKey });
  return { offer, appKey, hostKey, first, pairingKey: first.sealed.pairingKey };
}

describe("relay agent end to end", () => {
  it("pairs a phone through the QR text and serves requests from then on", async () => {
    const agent = runAgent();
    const { offer, appKey, hostKey, first, pairingKey } = await pairPhone(agent);

    const response = await first.client.fetch("/json", { headers: { cookie: "session=abc" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      marker: RESPONSE_MARKER,
      cookie: "session=abc",
    });
    await vi.waitFor(() =>
      expect(agent.lines).toContainEqual({
        event: "paired",
        channel: offer.channel,
        appKey: encodeRelayBytes(appKey.publicKey),
      }),
    );

    // The offer is single use: the relay forgot its token and the host its key.
    const stored = JSON.parse(
      await readFile(path.join(stateDir, "channels", `${offer.channel}.json`), "utf8"),
    );
    expect(stored.pairing).toBeNull();
    expect(stored.app).toMatchObject({
      key: encodeRelayBytes(appKey.publicKey),
      verifierSet: true,
    });
    const { token: pairToken } = await relayPairingSecrets(crypto, decodeRelayBytes(offer.secret));
    await expect(
      connectRelaySocket(
        `${ws(relay.url)}/v1/channels/${offer.channel}/app`,
        pairToken,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 404 });

    // A later session uses the app token and the pairing key.
    first.socket.close();
    const token = await relayAppToken(crypto, pairingKey);
    const later = await phone({ channel: offer.channel, token, psk: pairingKey, appKey, hostKey });
    const echoed = await later.client.fetch("/echo", { method: "POST", body: REQUEST_MARKER });
    expect(await echoed.text()).toBe(REQUEST_MARKER);

    const list = await cli(["list"]);
    expect(list.lines[0]).toEqual({
      channels: [
        {
          channel: offer.channel,
          relay: relay.url,
          state: "paired",
          appKey: encodeRelayBytes(appKey.publicKey),
          pairedAt: expect.any(Number),
        },
      ],
    });

    expect(await agent.stop()).toBe(0);
    expect(agent.lines.at(-1)).toEqual({ event: "stopped" });
  });

  it("streams server-sent events and runs requests side by side", async () => {
    const agent = runAgent();
    const { first } = await pairPhone(agent);

    const events = await first.client.fetch("/events");
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    const reader = (events.body as ReadableStream<Uint8Array>).getReader();
    const next = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await next()).toBe("data: first\n\n");

    const answers = await Promise.all(
      Array.from({ length: 24 }, async (_, index) => {
        const answer = await first.client.fetch(`/slow?i=${index}`);
        return Number(await answer.text());
      }),
    );
    expect(answers).toEqual(Array.from({ length: 24 }, (_, index) => index));

    local.push("second");
    expect(await next()).toBe("data: second\n\n");
    await reader.cancel();
    await agent.stop();
  });

  it("recovers when the relay goes away and comes back", async () => {
    const agent = runAgent();
    const { offer, appKey, hostKey, first, pairingKey } = await pairPhone(agent);
    expect((await first.client.fetch("/json")).status).toBe(200);
    await vi.waitFor(() => expect(agent.lines.some((line) => line.event === "paired")).toBe(true));

    const { port, state } = relay;
    await relay.close();
    await vi.waitFor(() =>
      expect(agent.lines).toContainEqual(
        expect.objectContaining({ event: "disconnected", channel: offer.channel }),
      ),
    );
    await expect(first.client.fetch("/json")).rejects.toThrow();

    const connections = agent.lines.filter((line) => line.event === "connected").length;
    relay = await startDevRelay({ port, state });
    await vi.waitFor(
      () =>
        expect(agent.lines.filter((line) => line.event === "connected")).toHaveLength(
          connections + 1,
        ),
      { timeout: 10_000 },
    );
    const token = await relayAppToken(crypto, pairingKey);
    const again = await phone({ channel: offer.channel, token, psk: pairingKey, appKey, hostKey });
    expect(await (await again.client.fetch("/json")).json()).toMatchObject({ ok: true });
    await agent.stop();
  });

  it("refuses the phone after the computer revokes the pairing", async () => {
    const agent = runAgent();
    const { offer, first, pairingKey } = await pairPhone(agent);
    expect((await first.client.fetch("/json")).status).toBe(200);
    await vi.waitFor(() => expect(agent.lines.some((line) => line.event === "paired")).toBe(true));

    const revoked = await cli(["revoke", offer.channel]);
    expect(revoked).toEqual({
      code: 0,
      lines: [{ event: "revoked", channel: offer.channel, relay: "deleted" }],
    });
    await expect(first.client.fetch("/json")).rejects.toThrow();
    const token = await relayAppToken(crypto, pairingKey);
    const refused = await connectRelaySocket(
      `${ws(relay.url)}/v1/channels/${offer.channel}/app`,
      token,
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RelayHttpError);
    expect((refused as RelayHttpError).status).toBe(404);
    expect(await readdir(path.join(stateDir, "channels"))).toEqual([]);
    expect((await cli(["list"])).lines[0]).toEqual({ channels: [] });
    await agent.stop();
  });

  it("refuses an expired offer on the phone, the relay and the computer", async () => {
    const past = Date.now() - 11 * 60 * 1000;
    const { lines } = await cli(["pair", "--relay", relay.url], { now: () => past });
    const offerLine = lines[0] as { channel: string; qr: string };
    expect(() => parseRelayPairingOffer(offerOf(offerLine.qr), Date.now())).toThrow(
      "pairing offer expired",
    );

    const offer = parseRelayPairingOffer(offerOf(offerLine.qr), past);
    const { token } = await relayPairingSecrets(crypto, decodeRelayBytes(offer.secret));
    await expect(
      connectRelaySocket(
        `${ws(relay.url)}/v1/channels/${offer.channel}/app`,
        token,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 404 });

    const agent = runAgent();
    await vi.waitFor(() =>
      expect(agent.lines).toContainEqual({ event: "expired", channel: offer.channel }),
    );
    expect(await readdir(path.join(stateDir, "channels"))).toEqual([]);
    await agent.stop();
  });

  it("lets the relay see ciphertext only", async () => {
    const agent = runAgent();
    const { offer, first, pairingKey } = await pairPhone(agent);
    const echoed = await first.client.fetch("/echo", { method: "POST", body: REQUEST_MARKER });
    expect(await echoed.text()).toBe(REQUEST_MARKER);
    expect(await (await first.client.fetch("/json")).json()).toMatchObject({
      marker: RESPONSE_MARKER,
    });
    await agent.stop();

    const seen = relay.seen.map((message) => Buffer.from(message));
    expect(seen.length).toBeGreaterThan(4);
    const secrets = [
      Buffer.from(REQUEST_MARKER),
      Buffer.from(RESPONSE_MARKER),
      Buffer.from("/echo"),
      Buffer.from(pairingKey),
      Buffer.from(decodeRelayBytes(offer.secret)),
    ];
    for (const message of seen)
      for (const secret of secrets) expect(message.includes(secret)).toBe(false);
  });
});

describe("relay agent command line", () => {
  it("answers usage errors with 64 and failures with 2", async () => {
    expect((await cli([])).code).toBe(64);
    expect((await cli(["dance"])).code).toBe(64);
    expect((await cli(["pair"])).code).toBe(64);
    expect((await cli(["revoke"])).code).toBe(64);
    expect((await cli(["run"])).code).toBe(64);
    const remote = await cli(["run", "--origin", "http://example.com"]);
    expect(remote.code).toBe(64);
    expect(remote.lines[0]).toEqual({
      event: "error",
      reason: "--origin must be a loopback http address",
    });
    expect((await cli(["pair", "--relay", "--state"])).code).toBe(64);
    expect((await cli(["run", "--origin", "ftp://127.0.0.1"])).code).toBe(64);

    const insecure = await cli(["pair", "--relay", "http://relay.example"]);
    expect(insecure).toEqual({
      code: 2,
      lines: [{ event: "error", reason: "relay address must be https" }],
    });
    expect((await cli(["revoke", "Q2hhbm5lbC1pZC0xMjM0NQ"])).lines[0]).toEqual({
      event: "error",
      reason: "no such channel",
    });
  });

  it("runs as a process until SIGTERM and writes one JSON object per line", async () => {
    const handlers = new Map<string, () => void>();
    const out: string[] = [];
    const proc = {
      argv: ["node", "agent", "run", "--origin", local.origin, "--state", stateDir],
      env: {},
      platform: "linux",
      once: (signal: string, handler: () => void) => handlers.set(signal, handler),
      stdout: { write: (text: string) => out.push(text) },
    } as unknown as Parameters<typeof relayAgentProcess>[0];
    const finished = relayAgentProcess(proc);
    expect([...handlers.keys()]).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")?.();
    expect(await finished).toBe(0);
    expect(out).toEqual(['{"event":"stopped"}\n']);
  });

  it("keeps state where the operating system keeps an app's settings", () => {
    expect(defaultRelayStateDir("darwin", {}, "/Users/u")).toBe(
      path.join("/Users/u", "Library", "Application Support", "dozo", "relay"),
    );
    expect(defaultRelayStateDir("win32", { APPDATA: "C:\\AppData" }, "C:\\Users\\u")).toBe(
      path.join("C:\\AppData", "dozo", "relay"),
    );
    expect(defaultRelayStateDir("win32", {}, "/home/u")).toBe(
      path.join("/home/u", "AppData", "Roaming", "dozo", "relay"),
    );
    expect(defaultRelayStateDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe(
      path.join("/cfg", "dozo", "relay"),
    );
    expect(defaultRelayStateDir("linux", {}, "/home/u")).toBe(
      path.join("/home/u", ".config", "dozo", "relay"),
    );
  });

  it("connects with the token in a header and reports a refused upgrade with its status", async () => {
    const signal = new AbortController().signal;
    await expect(
      connectRelaySocket(`${ws(relay.url)}/v1/channels/nope/host`, "x", signal),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(connectRelaySocket("ws://127.0.0.1:1/v1", "x", signal)).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort(new Error("stopping"));
    await expect(
      connectRelaySocket(`${ws(relay.url)}/v1/channels/nope/host`, "x", aborted.signal),
    ).rejects.toThrow("stopping");
  });
});
