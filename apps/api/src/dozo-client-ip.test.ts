import type { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import { createClientIpResolver } from "./client-ip.js";

// The production stack (dozo/deploy/README.md, Client addresses): a CDN's client header, the
// panel's proxy as the one trusted proxy, by container name. Addresses are on the stack's network.
const header = "x-cdn-client-ip";
const PROXY = "10.213.87.2";
const WEB = "10.213.87.5";
const stackNetwork = (() => ({
  eth0: [{ cidr: "10.213.87.9/24" }],
})) as unknown as typeof networkInterfaces;

const resolver = () =>
  createClientIpResolver(
    { trustedProxies: ["reverse-proxy"], header },
    {
      interfaces: stackNetwork,
      resolve: async (name) => (name === "reverse-proxy" ? [PROXY] : []),
    },
  );

describe("client address on the production stack", () => {
  it("reads the client header on a request from the panel's proxy", async () => {
    expect(await resolver()({ peer: PROXY, forwarded: "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("counts a request from the web container under the web container's address", async () => {
    expect(await resolver()({ peer: WEB, forwarded: "203.0.113.7" })).toBe(WEB);
  });
});
