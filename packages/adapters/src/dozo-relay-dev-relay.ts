import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  RELAY_MAX_MESSAGE_BYTES,
  RelayRegisterRequestSchema,
  RelaySetAppRequestSchema,
} from "@rakazo/contracts";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

/**
 * A relay in memory, for tests and local development only: the HTTP and socket contract of
 * `dozo/relay/PROTOCOL.md` without limits, persistence or TLS. It keeps every binary message it
 * forwarded in `seen`, so a test can check that the relay saw ciphertext only.
 */

type Role = "host" | "app";

type DevChannel = {
  hostVerifier: string;
  appVerifier: string | null;
  pairVerifier: string | null;
  pairExpiresAt: number;
  sockets: Partial<Record<Role, WebSocket>>;
};

/** The relay's channels; pass it to a new relay to keep them across a restart. */
export type DevRelayState = Map<string, DevChannel>;

export type DevRelay = {
  url: string;
  port: number;
  state: DevRelayState;
  seen: Uint8Array[];
  /** Closes every socket and stops listening; the state stays. */
  close(): Promise<void>;
};

const CHANNEL_PATH = /^\/v1\/channels\/([A-Za-z0-9_-]{1,64})(?:\/(host|app))?$/;
const MAX_BODY = 4096;
const PEER = (present: boolean) => JSON.stringify({ type: "peer", present });

export async function startDevRelay(
  options: { port?: number; host?: string; state?: DevRelayState } = {},
): Promise<DevRelay> {
  const state: DevRelayState = options.state ?? new Map();
  const seen: Uint8Array[] = [];
  const sockets = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_MESSAGE_BYTES });
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => answer(response, 400));
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://relay");
    if (request.method === "POST" && url.pathname === "/v1/channels") {
      const body = RelayRegisterRequestSchema.safeParse(await readJson(request));
      if (!body.success) return answer(response, 400);
      const channel = randomBytes(16).toString("base64url");
      state.set(channel, { ...body.data, appVerifier: null, sockets: {} });
      return answer(response, 201, { channel });
    }
    const match = CHANNEL_PATH.exec(url.pathname);
    const entry = match ? state.get(match[1] as string) : undefined;
    const token = verifierOf(request);
    if (!match || !entry || !token) return answer(response, 404);
    const [, channel, role] = match as unknown as [string, string, Role | undefined];
    if (request.method === "PUT" && role === "app" && same(token, entry.hostVerifier)) {
      const body = RelaySetAppRequestSchema.safeParse(await readJson(request));
      if (!body.success) return answer(response, 400);
      entry.appVerifier = body.data.appVerifier;
      entry.pairVerifier = null;
      return answer(response, 204);
    }
    const either = same(token, entry.hostVerifier) || same(token, entry.appVerifier);
    if (request.method === "DELETE" && !role && either) {
      for (const socket of Object.values(entry.sockets)) socket?.close(1000, "channel deleted");
      state.delete(channel);
      return answer(response, 204);
    }
    answer(response, 404);
  }

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // A refused client may reset the connection before reading the answer.
    socket.on("error", () => socket.destroy());
    const match = CHANNEL_PATH.exec(new URL(request.url ?? "/", "http://relay").pathname);
    const entry = match ? state.get(match[1] as string) : undefined;
    const role = match?.[2] as Role | undefined;
    const token = verifierOf(request);
    const allowed =
      entry &&
      token &&
      (role === "host"
        ? same(token, entry.hostVerifier)
        : role === "app" &&
          (same(token, entry.appVerifier) ||
            (!entry.appVerifier &&
              entry.pairExpiresAt > Date.now() &&
              same(token, entry.pairVerifier))));
    if (!entry || !role || !allowed) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => join(entry, role, ws));
  });

  function join(entry: DevChannel, role: Role, ws: WebSocket) {
    const otherRole: Role = role === "host" ? "app" : "host";
    entry.sockets[role]?.close(4000, "replaced");
    entry.sockets[role] = ws;
    const other = () => entry.sockets[otherRole];
    ws.send(PEER(Boolean(other())));
    other()?.send(PEER(true));
    ws.on("message", (data: Buffer, isBinary) => {
      if (!isBinary) {
        if (data.toString() === "ping") ws.send("pong");
        return;
      }
      seen.push(new Uint8Array(data));
      other()?.send(data, { binary: true });
    });
    // An oversized message: `ws` already closes the socket with 1009.
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      if (entry.sockets[role] !== ws) return;
      delete entry.sockets[role];
      other()?.send(PEER(false));
    });
  }

  server.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${port}`,
    port,
    state,
    seen,
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      for (const entry of state.values()) entry.sockets = {};
      sockets.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function answer(response: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) return void response.writeHead(status).end();
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > MAX_BODY) throw new Error("body too large");
  }
  return JSON.parse(text) as unknown;
}

/** The SHA-256 of the bearer token, as the relay stores it. */
function verifierOf(request: IncomingMessage) {
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
  return token ? createHash("sha256").update(token).digest("base64url") : null;
}

function same(a: string, b: string | null) {
  return b !== null && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
