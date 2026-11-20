import { getConnInfo } from "@hono/node-server/conninfo";
import type { RelaySessionAuth, RelaySessionPrisma } from "@rakazo/auth";
import {
  agentProofMatches,
  issueRelaySession,
  relayAgentKey,
  revokeRelaySession,
} from "@rakazo/auth";
import {
  RELAY_AGENT_PROOF_HEADER,
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
 * nothing but this computer (the web server's proxy adds itself), and carry the agent's proof of
 * the shared key. Any other caller gets the same 404 as a server without the feature.
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

type Deps = {
  auth: RelaySessionAuth;
  prisma: RelaySessionPrisma;
  key: string;
  /** The connecting socket's address; Node's by default. */
  socketAddress?: (c: Context) => string | undefined;
  now?: () => number;
};

export function dozoRelaySessionRoutes(deps: Deps) {
  const socketAddress = deps.socketAddress ?? ((c: Context) => getConnInfo(c).remote.address);
  const app = new Hono();
  /** The channel the agent names, when the request is the agent's own. */
  const agentChannel = (c: Context) => {
    const parsed = RelayChannelId.safeParse(c.req.header(RELAY_CHANNEL_HEADER));
    if (!parsed.success) return null;
    const local = addresses(c, socketAddress(c)).every(
      (address) => address !== undefined && LOOPBACK.has(address),
    );
    const proven = agentProofMatches(
      deps.key,
      c.req.header(RELAY_AGENT_PROOF_HEADER),
      { method: c.req.method, path: c.req.path, channel: parsed.data },
      (deps.now ?? Date.now)(),
    );
    return local && proven ? parsed.data : null;
  };

  app.post(RELAY_SESSION_PATH, async (c) => {
    const channel = agentChannel(c);
    if (!channel) return c.notFound();
    const result = await issueRelaySession({ prisma: deps.prisma, auth: deps.auth }, channel);
    if ("token" in result) return c.json({ token: result.token });
    return c.json({ reason: result.refused }, result.refused === "used" ? 410 : 409);
  });

  app.post(RELAY_SESSION_REVOKE_PATH, async (c) => {
    const channel = agentChannel(c);
    if (!channel) return c.notFound();
    await revokeRelaySession(deps.prisma, channel);
    return c.body(null, 204);
  });

  return app;
}

/**
 * Adds the routes, only on a server that gives phones a sign-in (`DOZO_RELAY_AGENT_KEY`).
 * Without the key the app is exactly as without this feature.
 */
export function mountDozoRelaySessions(
  app: { route(path: string, routes: Hono): unknown },
  deps: Omit<Deps, "key"> & { key?: string | null },
) {
  const key = deps.key === undefined ? relayAgentKey() : deps.key;
  if (key) app.route("/", dozoRelaySessionRoutes({ ...deps, key }));
}
