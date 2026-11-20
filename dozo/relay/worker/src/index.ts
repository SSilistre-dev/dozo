import { encodeRelayBytes } from "@dozo/relay-core/dozo-relay-channel";
import {
  RELAY_PAIRING_TTL_MS,
  RelayChannelId,
  RelayRegisterRequestSchema,
} from "@rakazo/contracts";
import type { Admission } from "./admission.js";
import { openAdmission } from "./admission.js";
import type { Env } from "./env.js";
import { settings } from "./env.js";
import { readJson, relayResponse } from "./http.js";
import { registry } from "./registry.js";

export { Channel } from "./channel.js";
export { Registry } from "./registry.js";

/** A host's clock may run a little ahead; an offer still may not outlive the pairing TTL by more. */
const CLOCK_SKEW_MS = 60 * 1000;
const CHANNEL_PATH = /^\/v1\/channels\/([^/]+)(?:\/(host|app))?$/;

/** The relay's HTTP front: limits per address, then the channel's own object. */
export function createRelay(admit: Admission): ExportedHandler<Env> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const address = request.headers.get("CF-Connecting-IP") ?? "unknown";

      if (url.pathname === "/v1/channels" && request.method === "POST") {
        if (!(await env.REGISTER_LIMIT.limit({ key: address })).success) {
          return relayResponse(429);
        }
        return register(request, env, admit);
      }

      const match = CHANNEL_PATH.exec(url.pathname);
      if (!match || !RelayChannelId.safeParse(match[1]).success) return relayResponse(404);
      const [, channel, role] = match;
      const allowed =
        (request.method === "DELETE" && !role) ||
        (request.method === "PUT" && role === "app") ||
        (request.method === "GET" &&
          role !== undefined &&
          request.headers.get("Upgrade")?.toLowerCase() === "websocket");
      if (!allowed) return relayResponse(404);
      if (!(await env.ACCESS_LIMIT.limit({ key: address })).success) return relayResponse(429);
      return env.CHANNELS.get(env.CHANNELS.idFromName(channel)).fetch(request);
    },
  };
}

async function register(request: Request, env: Env, admit: Admission) {
  const body = await readJson(request, RelayRegisterRequestSchema);
  const now = Date.now();
  if (
    !body ||
    body.pairExpiresAt <= now ||
    body.pairExpiresAt > now + RELAY_PAIRING_TTL_MS + CLOCK_SKEW_MS
  ) {
    return relayResponse(400);
  }
  if (!(await admit(request, body, env))) return relayResponse(404);

  const id = encodeRelayBytes(crypto.getRandomValues(new Uint8Array(16)));
  const { maxChannels } = settings(env);
  if (maxChannels > 0 && !(await registry(env).reserve(id, maxChannels))) return relayResponse(429);
  try {
    const created = await env.CHANNELS.get(env.CHANNELS.idFromName(id)).register({
      id,
      hostVerifier: body.hostVerifier,
      appVerifier: null,
      pairVerifier: body.pairVerifier,
      pairExpiresAt: body.pairExpiresAt,
      createdAt: now,
      seenAt: now,
    });
    if (!created) throw new Error("channel id collision");
  } catch (error) {
    // No channel came of it: give the count back.
    if (maxChannels > 0) await registry(env).release(id);
    throw error;
  }
  return relayResponse(201, { channel: id });
}

export default createRelay(openAdmission);
