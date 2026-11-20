import { DurableObject } from "cloudflare:workers";
import { RELAY_MAX_MESSAGE_BYTES, RelaySetAppRequestSchema } from "@rakazo/contracts";
import type { Env } from "./env.js";
import { settings } from "./env.js";
import { readJson, relayResponse } from "./http.js";
import { registry } from "./registry.js";
import { verifierOf } from "./tokens.js";

type Role = "host" | "app";

/** All the relay keeps about a channel: verifiers and timestamps, never content. */
export type ChannelRecord = {
  id: string;
  hostVerifier: string;
  /** Set once the host confirms the pairing; the pairing verifier is gone from then on. */
  appVerifier: string | null;
  pairVerifier: string | null;
  pairExpiresAt: number;
  createdAt: number;
  /** When an end last connected, kept to the day: it decides when an idle channel goes. */
  seenAt: number;
};

/** A socket is closed with this code when the channel is deleted (revoked or expired). */
export const CLOSE_DELETED = 4001;
const CLOSE_REPLACED = 4000;
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;

/** The host may still confirm a pairing this long after the offer expired; then it goes. */
export const PAIR_GRACE_MS = 2 * 60 * 1000;
/** `seenAt` is rewritten at most this often, so connects almost never write. */
const SEEN_RESOLUTION_MS = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/**
 * One channel: the two sockets of a host and its phone, paired and copied across. Sockets use the
 * hibernation API and `ping` is answered by the runtime, so an idle channel costs no duration.
 * Storage is written on register, pairing, delete and at most daily on connect; counters for the
 * per-minute limits live in memory and start again after the object hibernates.
 */
export class Channel extends DurableObject<Env> {
  private record: ChannelRecord | null | undefined;
  private attempts = new Window();
  private failures = new Window();
  private traffic = new Window();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Creates the channel; false when the id is taken (never, with 16 random bytes). */
  async register(record: ChannelRecord): Promise<boolean> {
    if (await this.load()) return false;
    await this.save(record);
    await this.ctx.storage.setAlarm(record.pairExpiresAt + PAIR_GRACE_MS);
    return true;
  }

  override async fetch(request: Request): Promise<Response> {
    // Hashed before the record is read: nothing below waits until the record is written again,
    // so a pairing or delete from a concurrent request cannot be overwritten with an old copy.
    const verifier = await verifierOf(request);
    const record = await this.load();
    if (!record) return relayResponse(404);
    const limits = settings(this.env);
    const now = Date.now();
    const isHost = verifier !== null && matches(verifier, record.hostVerifier);
    const isPairedApp = verifier !== null && matches(verifier, record.appVerifier);
    const isPairingApp =
      verifier !== null &&
      record.appVerifier === null &&
      now < record.pairExpiresAt &&
      matches(verifier, record.pairVerifier);
    const tail = new URL(request.url).pathname.split("/").at(-1);
    const allowed =
      request.method === "DELETE"
        ? isHost || isPairedApp
        : request.method === "PUT"
          ? tail === "app" && isHost
          : tail === "host"
            ? isHost
            : tail === "app" && (isPairedApp || isPairingApp);
    // Wrong tokens are limited apart from the ends' own requests, so guessing cannot lock them out.
    if (!allowed) {
      return relayResponse(this.failures.take(1, limits.attemptsPerMinute) ? 404 : 429);
    }
    if (!this.attempts.take(1, limits.attemptsPerMinute)) return relayResponse(429);

    if (request.method === "DELETE") {
      await this.destroy(record);
      return relayResponse(204);
    }
    if (request.method === "PUT") {
      const body = await readJson(request, RelaySetAppRequestSchema);
      if (!body) return relayResponse(400);
      const current = await this.load();
      // Deleted while the body was read: do not bring it back.
      if (!current) return relayResponse(404);
      if (current.appVerifier !== null && current.appVerifier !== body.appVerifier) {
        // A new phone replaces the old one: the old socket must not stay on the channel.
        for (const ws of this.ctx.getWebSockets("app")) ws.close(CLOSE_DELETED, "replaced");
      }
      await this.save({
        ...current,
        appVerifier: body.appVerifier,
        pairVerifier: null,
        seenAt: now,
      });
      await this.ctx.storage.setAlarm(now + limits.idleMs);
      return relayResponse(204);
    }
    const role = tail === "host" ? "host" : "app";
    await this.touch(record, now, limits.idleMs);
    if (!this.record) return relayResponse(404);
    return this.acceptSocket(role);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // `ping` never gets here: the runtime answers it without waking the object.
    if (typeof message === "string") return ws.close(CLOSE_UNSUPPORTED, "binary only");
    if (message.byteLength > RELAY_MAX_MESSAGE_BYTES) return ws.close(CLOSE_TOO_BIG, "too big");
    const limits = settings(this.env);
    if (
      !this.traffic.take(1, limits.messagesPerMinute, "messages") ||
      !this.traffic.take(message.byteLength, limits.bytesPerMinute, "bytes")
    ) {
      return ws.close(CLOSE_POLICY, "limit");
    }
    for (const peer of this.open(other(roleOf(this.ctx, ws)))) peer.send(message);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Completes the closing handshake; the runtime may already have done it.
    try {
      ws.close(validCloseCode(code) ? code : 1000, reason);
    } catch {
      // Already closed: nothing to answer.
    }
    this.left(ws);
  }

  override async webSocketError(ws: WebSocket) {
    this.left(ws);
  }

  override async alarm() {
    const record = await this.load();
    if (!record) return;
    const now = Date.now();
    if (record.appVerifier === null) {
      const deadline = record.pairExpiresAt + PAIR_GRACE_MS;
      if (now >= deadline) await this.destroy(record);
      else await this.ctx.storage.setAlarm(deadline);
      return;
    }
    const { idleMs } = settings(this.env);
    const connected = this.ctx.getWebSockets().length > 0;
    if (connected) await this.touch(record, now, idleMs, true);
    else if (now >= record.seenAt + idleMs) await this.destroy(record);
    else await this.ctx.storage.setAlarm(record.seenAt + idleMs);
  }

  private acceptSocket(role: Role) {
    for (const old of this.ctx.getWebSockets(role)) old.close(CLOSE_REPLACED, "replaced");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    const peers = this.open(other(role));
    server.send(peerMessage(peers.length > 0));
    for (const peer of peers) peer.send(peerMessage(true));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Tells the other role when the last socket of this one is gone. */
  private left(ws: WebSocket) {
    const role = roleOf(this.ctx, ws);
    if (!role || this.open(role).some((socket) => socket !== ws)) return;
    for (const peer of this.open(other(role))) peer.send(peerMessage(false));
  }

  private open(role: Role | null) {
    if (!role) return [];
    return this.ctx.getWebSockets(role).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private async touch(record: ChannelRecord, now: number, idleMs: number, always = false) {
    if (record.appVerifier === null) return;
    if (!always && now - record.seenAt < SEEN_RESOLUTION_MS) return;
    await this.save({ ...record, seenAt: now });
    await this.ctx.storage.setAlarm(now + idleMs);
  }

  private async destroy(record: ChannelRecord) {
    // Released first: if that call fails the channel is still here and its alarm tries again.
    if (settings(this.env).maxChannels > 0) await registry(this.env).release(record.id);
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_DELETED, "deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.record = null;
  }

  private async load() {
    if (this.record === undefined) {
      this.record = (await this.ctx.storage.get<ChannelRecord>("record")) ?? null;
    }
    return this.record;
  }

  private async save(record: ChannelRecord) {
    await this.ctx.storage.put("record", record);
    this.record = record;
  }
}

/** Fixed one-minute windows: enough to bound a burst, and nothing to store. */
class Window {
  private start = 0;
  private used = new Map<string, number>();

  take(amount: number, limit: number, kind = "") {
    const now = Date.now();
    if (now - this.start >= MINUTE) {
      this.start = now;
      this.used.clear();
    }
    const used = (this.used.get(kind) ?? 0) + amount;
    if (used > limit) return false;
    this.used.set(kind, used);
    return true;
  }
}

function matches(verifier: Uint8Array, stored: string | null) {
  if (stored === null) return false;
  const expected = new TextEncoder().encode(stored);
  return expected.length === verifier.length && crypto.subtle.timingSafeEqual(expected, verifier);
}

function roleOf(ctx: DurableObjectState, ws: WebSocket): Role | null {
  const tag = ctx.getTags(ws)[0];
  return tag === "host" || tag === "app" ? tag : null;
}

function other(role: Role | null): Role | null {
  if (!role) return null;
  return role === "host" ? "app" : "host";
}

function peerMessage(present: boolean) {
  return JSON.stringify({ type: "peer", present });
}

function validCloseCode(code: number) {
  return code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code);
}
