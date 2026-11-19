import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expireComputerControl } from "./computer-control.js";
import { auditSiteSessionsAfterControl } from "./dozo-site-session-audit.js";

const audit = vi.hoisted(() => vi.fn(async (_input: unknown) => undefined));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  recordAuditEvent: audit,
}));

const GRANTED = new Date("2026-11-19T10:00:00.000Z");
const context = { botId: "bot-1", operationId: "test" } as AdapterContext;
const running = {
  spaceId: "space-1",
  homeKey: "team-1",
  kind: "docker",
  providerRef: "ref",
  state: "running",
  controlUserId: "ada",
};

/** A bot's grants and a computer whose browser answers the session script. */
function deps(granted: Date | null) {
  const asked: Record<string, unknown>[] = [];
  return {
    asked,
    deps: {
      prisma: {
        event: {
          findMany: vi.fn(async () =>
            granted
              ? [
                  { id: "e2", createdAt: new Date(0), payload: { leaseId: "other" } },
                  { id: "e3", createdAt: new Date(0), payload: "sealed-garbage" },
                  { id: "e1", createdAt: granted, payload: { leaseId: "lease-1" } },
                ]
              : [],
          ),
        },
      },
      sandbox: {
        async *execute(
          _computer: ComputerRef,
          command: { argv: string[] },
          _ctx: AdapterContext,
        ): AsyncIterable<ProcessEvent> {
          asked.push(JSON.parse(command.argv.at(-1)!));
          const t = GRANTED.getTime();
          const hosts = [
            // Set before control: not this person's.
            { host: "old.example", created: t - 1, lastUsed: t },
            { host: "accounts.example.com", created: t + 5, lastUsed: 0 },
            { host: "example.com", created: t + 9, lastUsed: 0 },
            // Not saved yet: set within the last half minute.
            { host: "unsaved.example", created: null, lastUsed: null },
            { host: "older.example", created: t - 9, lastUsed: null },
            // A tracker the visited page loaded: never opened at the top level.
            { host: "tracker.example", created: t + 3, lastUsed: 0 },
          ];
          const visited = ["accounts.example.com", "unsaved.example", "old.example"];
          yield {
            type: "stdout",
            data: JSON.stringify({ ok: true, hosts, visited, storageKeys: [] }),
          };
          yield { type: "exit", code: 0 };
        },
      },
    },
  };
}

const opened = (site: string) => ({
  action: "computer.site.session_opened",
  actor: { type: "user", id: "ada" },
  spaceId: "space-1",
  target: { type: "bot", id: "bot-1" },
  metadata: { site, via: "control" },
});

beforeEach(() => audit.mockClear());

describe("sites opened under a person's control", () => {
  it("records each site they opened at the top level whose first cookie came while they held the screen", async () => {
    const { deps: d, asked } = deps(GRANTED);
    auditSiteSessionsAfterControl(d as never, running, "bot-1", "lease-1", context);
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(2));
    expect(audit).toHaveBeenCalledWith(opened("example.com"));
    expect(audit).toHaveBeenCalledWith(opened("unsaved.example"));
    expect(asked[0]).toMatchObject({ op: "list", since: GRANTED.getTime() });
  });

  it("records nothing without the grant, a person, or a computer that can tell", async () => {
    const none = deps(null);
    auditSiteSessionsAfterControl(none.deps as never, running, "bot-1", "lease-1", context);
    await vi.waitFor(() => expect(none.deps.prisma.event.findMany).toHaveBeenCalled());
    const other = deps(GRANTED);
    for (const computer of [
      { ...running, kind: "desktop" },
      { ...running, state: "stopped" },
      { ...running, providerRef: null },
      { ...running, controlUserId: null },
    ]) {
      auditSiteSessionsAfterControl(other.deps as never, computer, "bot-1", "lease-1", context);
    }
    auditSiteSessionsAfterControl(other.deps as never, running, null, "lease-1", context);
    expect(other.deps.prisma.event.findMany).not.toHaveBeenCalled();
    expect(other.asked).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("is recorded when control lapses on its own, not only when it is handed back", async () => {
    const { deps: d } = deps(GRANTED);
    const row = {
      id: "computer-1",
      ...running,
      controlHolder: "user",
      controlLeaseId: "lease-1",
      controlBotId: "bot-1",
      controlLeaseExpiresAt: new Date(0),
      userId: "owner",
    };
    const prisma = {
      ...d.prisma,
      computer: {
        findUnique: vi.fn(async () => row),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const expired = await expireComputerControl(
      {
        prisma: prisma as never,
        sandbox: { ...d.sandbox, setScreenControl: vi.fn(async () => undefined) } as never,
        jobs: { cancel: vi.fn(async () => undefined) } as never,
        events: { releaseUserControl: vi.fn(async () => true) } as never,
      },
      "computer-1",
      "lease-1",
    );
    expect(expired).toBe(true);
    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith(opened("example.com")));
  });
});
