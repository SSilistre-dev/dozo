import type { AcpAgentEntry } from "./dozo-acp-agent.js";

/**
 * Agents driven over ACP, each started as its maker documents for ACP clients. Antigravity's CLI
 * was seen at 1.5.13 (its ACP `initialize`, no turn yet); Grok's has not been run with Dozo, so no
 * version of it passes the check until one is.
 */
export const ACP_AGENTS: readonly AcpAgentEntry[] = [
  {
    provider: "antigravity-agent",
    name: "Antigravity",
    command: "agy",
    downloadUrl: "https://antigravity.google/product/antigravity-cli",
    args: ["acp"],
    versions: { min: [1, 5, 0], below: [1, 6, 0] },
    // Google's terms count use of this sign-in outside its own products as a reason to close it.
    termsRisk: true,
  },
  {
    provider: "grok-agent",
    name: "Grok",
    command: "grok",
    downloadUrl: "https://docs.x.ai/build/overview",
    args: ["agent", "stdio"],
    // Its headless guide signs in with the cached sign-in of `grok login`, never an API key.
    authenticate: (methods) =>
      methods.some((method) => method.id === "cached_token")
        ? { methodId: "cached_token", _meta: { headless: true } }
        : undefined,
  },
];
