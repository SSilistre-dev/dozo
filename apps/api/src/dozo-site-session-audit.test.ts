import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import type { Computer } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditSiteSessionsAfterControl } from "./dozo-site-session-audit.js";
import type { RouterDeps } from "./router.js";

const audit = vi.hoisted(() => vi.fn(async (_input: unknown) => undefined));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  recordAuditEvent: audit,
}));

const GRANTED = new Date("2026-11-19T10:00:00.000Z");
const actor = { userId: "ada", spaceId: "space-1" } as Actor;
const running = { kind: "docker", providerRef: "ref", state: "running" } as Computer;

function deps(granted: Date | null) {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      prisma: {
        event: { findFirst: vi.fn(async () => (granted ? { createdAt: granted } : null)) },
      },
      sandbox: {
        async *execute(
          _computer: ComputerRef,
          command: { argv: string[] },
          _ctx: AdapterContext,
        ): AsyncIterable<ProcessEvent> {
          asked.push(JSON.parse(command.argv.at(-1)!).op);
          const hosts = [
            { host: "old.example", created: GRANTED.getTime() - 1, lastUsed: GRANTED.getTime() },
            { host: "accounts.example.com", created: GRANTED.getTime() + 5, lastUsed: 0 },
            { host: "example.com", created: GRANTED.getTime() + 9, lastUsed: 0 },
            { host: "unsaved.example", created: null, lastUsed: null },
          ];
          yield { type: "stdout", data: JSON.stringify({ ok: true, hosts }) };
          yield { type: "exit", code: 0 };
        },
      },
    } as unknown as Pick<RouterDeps, "prisma" | "sandbox">,
  };
}

beforeEach(() => audit.mockClear());

describe("sites opened under a person's control", () => {
  it("records each site whose first cookie came while they held the screen", async () => {
    const { deps: d } = deps(GRANTED);
    auditSiteSessionsAfterControl(d, actor, running, "bot-1", "lease-1");
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1));
    expect(audit).toHaveBeenCalledWith({
      action: "computer.site.session_opened",
      actor: { type: "user", id: "ada" },
      spaceId: "space-1",
      target: { type: "bot", id: "bot-1" },
      metadata: { site: "example.com", via: "control" },
    });
  });

  it("records nothing without the grant, or on a computer that cannot tell", async () => {
    const none = deps(null);
    auditSiteSessionsAfterControl(none.deps, actor, running, "bot-1", "lease-1");
    await vi.waitFor(() => expect(none.deps.prisma.event.findFirst).toHaveBeenCalled());
    const other = deps(GRANTED);
    auditSiteSessionsAfterControl(other.deps, actor, { ...running, kind: "desktop" }, "bot-1", "l");
    auditSiteSessionsAfterControl(
      other.deps,
      actor,
      { ...running, state: "stopped" },
      "bot-1",
      "l",
    );
    expect(other.asked).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});
