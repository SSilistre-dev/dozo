import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { issueRelaySession, revokeRelaySession } from "@rakazo/auth";
import {
  RELAY_AGENT_KEY_HEADER,
  RELAY_CHANNEL_HEADER,
  RELAY_SESSION_PATH,
  RELAY_SESSION_REVOKE_PATH,
} from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dozoRelaySessionRoutes } from "./dozo-relay-session.js";

vi.mock("@rakazo/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/auth")>()),
  issueRelaySession: vi.fn(),
  revokeRelaySession: vi.fn(async () => undefined),
}));

const KEY = "c".repeat(64);
const CHANNEL = "A".repeat(22);
const deps = { auth: {} as never, prisma: {} as never };

function routes(options: { key?: string | null; socket?: string } = {}) {
  return dozoRelaySessionRoutes({
    ...deps,
    key: options.key === undefined ? KEY : options.key,
    socketAddress: () => options.socket ?? "127.0.0.1",
  });
}

function ask(
  app: ReturnType<typeof routes>,
  headers: Record<string, string> = {},
  path = RELAY_SESSION_PATH,
) {
  return app.request(path, {
    method: "POST",
    headers: { [RELAY_AGENT_KEY_HEADER]: KEY, [RELAY_CHANNEL_HEADER]: CHANNEL, ...headers },
  });
}

beforeEach(() => {
  vi.mocked(issueRelaySession).mockReset();
  vi.mocked(issueRelaySession).mockResolvedValue({ token: "session.signature" });
  vi.mocked(revokeRelaySession).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a phone's sign-in, asked by the computer's agent", () => {
  it("gives the session to the agent on this computer, for the channel it names", async () => {
    const response = await ask(routes());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "session.signature" });
    expect(issueRelaySession).toHaveBeenCalledWith(expect.anything(), CHANNEL);
    // Through the local web server's proxy, which names this computer too.
    expect((await ask(routes(), { "x-forwarded-for": "127.0.0.1" })).status).toBe(200);
    expect((await ask(routes({ socket: "::ffff:127.0.0.1" }))).status).toBe(200);
  });

  it("says why it gives none", async () => {
    vi.mocked(issueRelaySession).mockResolvedValueOnce({ refused: "sign-in-on-computer" });
    const signIn = await ask(routes());
    expect(signIn.status).toBe(409);
    expect(await signIn.json()).toEqual({ reason: "sign-in-on-computer" });
    vi.mocked(issueRelaySession).mockResolvedValueOnce({ refused: "used" });
    expect((await ask(routes())).status).toBe(410);
  });

  it.each([
    ["a server without the agent's key", { key: null }, {}],
    ["another machine", { socket: "192.0.2.7" }, {}],
    ["no socket address", { socket: "" }, {}],
    ["a proxy forwarding another machine", {}, { "x-forwarded-for": "127.0.0.1, 203.0.113.5" }],
    ["a forwarded header naming another machine", {}, { forwarded: 'for="[2001:db8::1]"' }],
    ["a wrong key", {}, { [RELAY_AGENT_KEY_HEADER]: "d".repeat(64) }],
    ["a key of the wrong shape", {}, { [RELAY_AGENT_KEY_HEADER]: "short" }],
    ["no key", {}, { [RELAY_AGENT_KEY_HEADER]: "" }],
    ["a channel of the wrong shape", {}, { [RELAY_CHANNEL_HEADER]: "../x" }],
    ["no channel", {}, { [RELAY_CHANNEL_HEADER]: "" }],
  ])("answers 404, as without the feature, to %s", async (_name, options, headers) => {
    const app = routes(options as { key?: string | null; socket?: string });
    expect((await ask(app, headers)).status).toBe(404);
    expect((await ask(app, headers, RELAY_SESSION_REVOKE_PATH)).status).toBe(404);
    expect(issueRelaySession).not.toHaveBeenCalled();
    expect(revokeRelaySession).not.toHaveBeenCalled();
  });

  it("ends a channel's sign-in for the agent", async () => {
    const response = await ask(routes(), {}, RELAY_SESSION_REVOKE_PATH);
    expect(response.status).toBe(204);
    expect(revokeRelaySession).toHaveBeenCalledWith(deps.prisma, CHANNEL);
  });

  it("reads the key from the environment, and the socket from Node's server", async () => {
    vi.stubEnv("DOZO_RELAY_AGENT_KEY", KEY);
    const app = dozoRelaySessionRoutes(deps);
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${RELAY_SESSION_PATH}`, {
        method: "POST",
        headers: { [RELAY_AGENT_KEY_HEADER]: KEY, [RELAY_CHANNEL_HEADER]: CHANNEL },
      });
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
