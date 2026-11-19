import { os } from "@orpc/server";
import type * as Adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import { vi } from "vitest";

// Shared state and mock factories of the admin tests. Each test file registers them with
// `vi.mock(path, async (original) => (await import("./dozo-admin-mocks.test-support.js")).<factory>(original))`.
// This file must not import the modules that are mocked.

export const stops = {
  calls: [] as { actor: unknown; botId: string }[],
  fail: null as Error | null,
};
export const audit = { events: [] as Record<string, unknown>[] };
export const host = { memory: vi.fn() };

// The app's own Stop is upstream's and has its own tests; here it only has to be reached, as
// the right person.
export const computerRoutesMock = () => ({
  computerRoutes: () => ({
    computer: {
      stop: os.$context<{ actor: Actor | null }>().handler(async ({ context, input }) => {
        if (stops.fail) throw stops.fail;
        stops.calls.push({ actor: context.actor, botId: (input as { botId: string }).botId });
        return {};
      }),
    },
  }),
});

// A provider that declares a memory read, standing in for the Docker host's.
export async function adaptersMock(original: () => Promise<typeof Adapters>) {
  const real = await original();
  return {
    ...real,
    sandboxKindCapabilities: (kind: string | null | undefined) =>
      kind === "memory-host" ? { memory: host.memory } : real.sandboxKindCapabilities(kind),
  };
}

export async function dbMock(original: () => Promise<typeof Db>) {
  return {
    ...(await original()),
    cancelDeactivatedAccountRuns: vi.fn(async () => 0),
    leaveInvitedSpaces: vi.fn(async () => []),
    recordSecurityEvent: vi.fn(async () => undefined),
    // The audit primitive has its own tests; here it only has to be asked, with the right facts.
    recordAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
      audit.events.push(event);
    }),
  };
}
