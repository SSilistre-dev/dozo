import { describe, expect, it, vi } from "vitest";
import {
  BRIEFING_BACKUP_MS,
  dozoSpokenBriefingAfterRun,
  parseBriefingScript,
  spokenBriefingJobKey,
} from "./dozo-spoken-briefing.js";
import {
  BRIEFING_MAX_LINES,
  BRIEFING_MAX_SPOKEN_CHARS,
  spokenBriefingPrompt,
} from "./dozo-spoken-briefing.prompt.js";
import type { RunContext } from "./runs/assembly/run-context.js";

describe("a briefing's script", () => {
  it("keeps the two hosts' lines in order, without markdown or other text", () => {
    expect(
      parseBriefingScript(
        "Here is the script:\nA: Three **orders** shipped.\n\n**B:** And the fourth?\nNote\nA : It ships `tomorrow`.",
      ),
    ).toEqual([
      { speaker: "A", text: "Three orders shipped." },
      { speaker: "B", text: "And the fourth?" },
      { speaker: "A", text: "It ships tomorrow." },
    ]);
  });

  it("is nothing unless both hosts speak", () => {
    expect(parseBriefingScript("A: One.\nA: Two.")).toEqual([]);
    expect(parseBriefingScript("")).toEqual([]);
  });

  it("stops at the line cap and before a line past the spoken-length cap", () => {
    const many = Array.from({ length: 30 }, (_, at) => `${at % 2 ? "B" : "A"}: Line ${at}.`);
    expect(parseBriefingScript(many.join("\n"))).toHaveLength(BRIEFING_MAX_LINES);
    const long = "x".repeat(BRIEFING_MAX_SPOKEN_CHARS / 2);
    const lines = parseBriefingScript(`A: ${long}\nB: ${long}\nA: More.`);
    expect(lines.map((line) => line.speaker)).toEqual(["A", "B"]);
  });

  it("gives the model each host's persona and the result, cut to their caps", () => {
    const prompt = spokenBriefingPrompt({
      host: { name: "Chef", description: "Cooks", instructions: "Be warm." },
      coHost: { name: "Nova", description: "", instructions: "y".repeat(5_000) },
      result: "z".repeat(10_000),
    });
    expect(prompt).toContain("<host_a>\nChef\nCooks\nBe warm.\n</host_a>");
    expect(prompt).toMatch(/<host_b>\nNova\ny{1195}\n<\/host_b>/);
    expect(prompt).toMatch(/<result>\nz{6000}\n<\/result>/);
  });
});

describe("after a run completes", () => {
  function context(run: { trigger: string; routineId: string | null }, coHost: string | null) {
    const queryRaw = vi.fn(async () => (coHost ? [{ coHostBotId: coHost }] : []));
    const enqueue = vi.fn(async () => undefined);
    const ctx = {
      run: { id: "run-1", ...run },
      deps: { prisma: { $queryRaw: queryRaw }, jobs: { enqueue, cancel: vi.fn() } },
    } as unknown as RunContext;
    return { ctx, queryRaw, enqueue };
  }

  it("reads nothing for a run no routine started", async () => {
    const { ctx, queryRaw } = context({ trigger: "user", routineId: null }, "bot-2");
    const start = vi.fn();
    await dozoSpokenBriefingAfterRun(ctx, start);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("does nothing more for a routine without a co-host", async () => {
    const { ctx, queryRaw, enqueue } = context(
      { trigger: "routine", routineId: "routine-1" },
      null,
    );
    const start = vi.fn();
    await dozoSpokenBriefingAfterRun(ctx, start);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("records the backup job for once the attempt is surely over, then starts the briefing here", async () => {
    const { ctx, enqueue } = context({ trigger: "routine", routineId: "routine-1" }, "bot-2");
    const start = vi.fn();
    const before = Date.now();
    await dozoSpokenBriefingAfterRun(ctx, start);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "routine.spoken-briefing",
        payload: { runId: "run-1" },
        replaceKey: spokenBriefingJobKey("run-1"),
      }),
    );
    const [[job]] = enqueue.mock.calls as unknown as [[{ availableAt: Date }]];
    expect(job.availableAt.getTime()).toBeGreaterThanOrEqual(before + BRIEFING_BACKUP_MS);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("never fails the run", async () => {
    const { ctx, queryRaw } = context({ trigger: "routine", routineId: "routine-1" }, "bot-2");
    queryRaw.mockRejectedValue(new Error("database down"));
    await expect(dozoSpokenBriefingAfterRun(ctx, vi.fn())).resolves.toBeUndefined();
  });
});
