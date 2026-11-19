import { INTEGRATION_CLAIMS_PATH, PLUGIN_SUBMISSIONS_PATH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { pluginSubmissionRoutes } from "./dozo-plugin-submissions.js";

const valid = {
  email: "dev@example.test",
  name: "Acme Tickets",
  logo: "https://example.test/logo.svg",
  source: "https://github.com/acme/plugins/tree/main/tickets",
  description: "Search Acme tickets.",
  testing: "Ask a bot to find ticket 42.",
  tested: true,
};

function routes(closed?: boolean) {
  const create = vi.fn();
  const prisma = {
    pluginSubmission: { create, findFirst: vi.fn(), findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient;
  const app = pluginSubmissionRoutes(
    { prisma, adminEmails: [], webOrigin: "https://app.example.test", clientIp: () => "192.0.2.1" },
    closed,
  );
  return { app, create };
}

const submit = (body: string) =>
  ({ method: "POST", headers: { "content-type": "application/json" }, body }) as const;

describe("plugin submissions", () => {
  it("answers 403 to a submission while closed and stores nothing", async () => {
    const { app, create } = routes(true);
    const response = await app.request(PLUGIN_SUBMISSIONS_PATH, submit(JSON.stringify(valid)));
    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the other routes while closed", async () => {
    const { app } = routes(true);
    const response = await app.request(INTEGRATION_CLAIMS_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ claims: [] });
  });

  it("is closed by DOZO_PLUGIN_SUBMISSIONS=closed", async () => {
    vi.stubEnv("DOZO_PLUGIN_SUBMISSIONS", "closed");
    try {
      const response = await routes().app.request(PLUGIN_SUBMISSIONS_PATH, submit("{}"));
      expect(response.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reaches the submission handler while open", async () => {
    const { app } = routes(false);
    const response = await app.request(PLUGIN_SUBMISSIONS_PATH, submit("not json"));
    expect(response.status).toBe(400);
  });
});
