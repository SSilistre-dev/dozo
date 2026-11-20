import { getConnInfo } from "@hono/node-server/conninfo";
import type { RelaySessionAuth, RelaySessionPrisma } from "@rakazo/auth";
import {
  agentKeyMatches,
  issueRelaySession,
  relayAgentKey,
  revokeRelaySession,
} from "@rakazo/auth";
import {
  RELAY_AGENT_KEY_HEADER,
  RELAY_CHANNEL_HEADER,
  RELAY_SESSION_PATH,
  RELAY_SESSION_REVOKE_PATH,
  RelayChannelId,
} from "@rakazo/contracts";
import type { Context } from "hono";
import { Hono } from "hono";

/**
 * The local server's side of a paired phone's sign-in (`packages/auth/src/dozo-relay-session.ts`).
 * Only the computer's relay agent reaches it: the request must come from this computer, through
 * nothing but this computer (the web server's proxy adds itself), and carry the agent's key. Any
 * other caller gets the same 404 as a server without the feature, so nothing tells them apart.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Every address a request names: the socket's, then each one a proxy on the way added. */
function addresses(c: Context, socket: string | undefined) {
  const forwarded = [
    ...(c.req.header("x-forwarded-for") ?? "").split(","),
    ...[...(c.req.header("forwarded") ?? "").matchAll(/for="?\[?([^\]";,]+)/gi)].map((m) => m[1]),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [socket, ...forwarded];
}

export function dozoRelaySessionRoutes(deps: {
  auth: RelaySessionAuth;
  prisma: RelaySessionPrisma;
  /** Defaults to `DOZO_RELAY_AGENT_KEY`; null turns the routes off. */
  key?: string | null;
  /** The connecting socket's address; Node's by default. */
  socketAddress?: (c: Context) => string | undefined;
}) {
  const key = deps.key === undefined ? relayAgentKey() : deps.key;
  const socketAddress = deps.socketAddress ?? ((c: Context) => getConnInfo(c).remote.address);
  const app = new Hono();
  const fromAgent = (c: Context) =>
    Boolean(key) &&
    addresses(c, socketAddress(c)).every(
      (address) => address !== undefined && LOOPBACK.has(address),
    ) &&
    agentKeyMatches(key, c.req.header(RELAY_AGENT_KEY_HEADER));
  const channelOf = (c: Context) => {
    const parsed = RelayChannelId.safeParse(c.req.header(RELAY_CHANNEL_HEADER));
    return parsed.success ? parsed.data : null;
  };

  app.post(RELAY_SESSION_PATH, async (c) => {
    const channel = channelOf(c);
    if (!fromAgent(c) || !channel) return c.notFound();
    const result = await issueRelaySession(deps, channel);
    if ("token" in result) return c.json({ token: result.token });
    return c.json({ reason: result.refused }, result.refused === "used" ? 410 : 409);
  });

  app.post(RELAY_SESSION_REVOKE_PATH, async (c) => {
    const channel = channelOf(c);
    if (!fromAgent(c) || !channel) return c.notFound();
    await revokeRelaySession(deps.prisma, channel);
    return c.body(null, 204);
  });

  return app;
}
