import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { dozoLocalModelsRoutes } from "./dozo-local-models.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

/** A fake network: only the servers in `running` answer, each with its own model list. */
function network(running: Record<string, string[]>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const models = running[url.port];
    if (!models) throw new TypeError("fetch failed: connection refused");
    return new Response(JSON.stringify({ object: "list", data: models.map((id) => ({ id })) }), {
      headers: { "content-type": "application/json" },
    });
  });
}

function client(allowPrivate: boolean, fetch: typeof globalThis.fetch) {
  const ctx = createRouterContext({
    prisma: { space: { findUnique: async () => null } },
    events: { notify: () => undefined, publishSpaceChange: () => undefined },
    env: { mcpAllowPrivateEndpoint: allowPrivate },
    modelConnectionFetch: fetch,
  } as unknown as RouterDeps);
  return createRouterClient(dozoLocalModelsRoutes(ctx), {
    context: {
      actor: {
        userId: "ada",
        spaceId: "space-ada",
        email: "ada@example.test",
        isDeploymentOwner: false,
      },
    },
  }).dozoLocalModels;
}

describe("local model servers", () => {
  it("never looks where private addresses are not allowed", async () => {
    const fetch = network({ "11434": ["qwen3:4b"] });
    expect(await client(false, fetch).servers()).toEqual({ available: false, servers: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists the servers that answer, with the models each one lists", async () => {
    const fetch = network({ "11434": ["qwen3:4b", "llama3.1:8b"], "1234": [] });
    expect(await client(true, fetch).servers()).toEqual({
      available: true,
      servers: [
        {
          name: "Ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          models: ["qwen3:4b", "llama3.1:8b"],
        },
        { name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", models: [] },
      ],
    });
    const asked = fetch.mock.calls.map(([input]) => String(input));
    expect(asked).toContain("http://127.0.0.1:11434/v1/models");
    expect(asked).toContain("http://127.0.0.1:8000/v1/models");
  });

  it("leaves out a server that answers with something other than a models list", async () => {
    const fetch = vi.fn(async () => new Response("<html></html>", { status: 404 }));
    expect(await client(true, fetch).servers()).toEqual({ available: true, servers: [] });
  });
});
