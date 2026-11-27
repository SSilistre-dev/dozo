import { queueStartOrder } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { QueueRun, QueueSnapshot } from "./dozo-queue-plan.js";
import { planQueue, queueLabel } from "./dozo-queue-plan.js";

const NOW = new Date("2026-11-21T12:00:00Z");
const ME = "user-me";
const OTHER = "user-other";
let tick = 0;

function run(id: string, patch: Partial<QueueRun> = {}): QueueRun {
  tick += 1;
  return {
    id,
    botId: "bot-1",
    userId: ME,
    status: "queued",
    trigger: "user",
    wakeAt: null,
    createdAt: new Date(NOW.getTime() - 60_000 + tick * 1000),
    threadId: "thread-1",
    routineName: null,
    sourceMessageId: null,
    ...patch,
  };
}

function snapshot(patch: Partial<QueueSnapshot>): QueueSnapshot {
  return {
    actorUserId: ME,
    threadId: "thread-1",
    now: NOW,
    bots: [{ id: "bot-1", computerId: "computer-1" }],
    runs: [],
    holding: [],
    leases: [],
    held: [],
    previews: new Map(),
    ...patch,
  };
}

describe("a run waiting for its bot", () => {
  it("is in line, in the order the bot will start them, while another run of the bot works", () => {
    const working = run("working", { status: "running", userId: OTHER });
    const first = run("first", { userId: OTHER });
    const second = run("second");
    const items = planQueue(snapshot({ runs: [second, working, first] }));
    expect(items.map((item) => [item.id, item.position, item.reason, item.mine])).toEqual([
      ["first", 1, "bot_busy", false],
      ["second", 2, "bot_busy", true],
    ]);
  });

  it("is in the order `startNextWaitingRun` starts them in, ties included", () => {
    // That function asks the database for `queueStartOrder()`; the line must put the runs in the
    // order those keys give, so the place shown is the one that comes up. If either side changes
    // its order on its own, this or the starter's own test (adapters) fails.
    const same = new Date(NOW.getTime() - 5_000);
    const older = run("older");
    const tied = ["m", "c", "x", "a"].map((id) => run(id, { createdAt: same }));
    const keys = queueStartOrder().flatMap((entry) => Object.keys(entry)) as Array<
      "createdAt" | "id"
    >;
    const byKeys = [older, ...tied].sort((a, b) => {
      for (const key of keys) {
        if (a[key] < b[key]) return -1;
        if (a[key] > b[key]) return 1;
      }
      return 0;
    });
    const working = run("working", { status: "running", userId: OTHER });
    const items = planQueue(snapshot({ runs: [...tied.reverse(), working, older] }));
    expect(items.map((item) => item.id)).toEqual(byKeys.map((entry) => entry.id));
  });

  it("puts a person's run before a routine's, though the routine is older, as it starts", () => {
    const working = run("working", { status: "running", userId: OTHER });
    const routine = run("routine", { trigger: "routine", routineName: "Weekly sums" });
    const person = run("person", { trigger: "follow_up" });
    const items = planQueue(snapshot({ runs: [person, working, routine] }));
    expect(items.map((item) => [item.id, item.position])).toEqual([
      ["person", 1],
      ["routine", 2],
    ]);
  });

  it("is not in line when nothing is in its way, the first moments of a run", () => {
    expect(planQueue(snapshot({ runs: [run("starting")] }))).toEqual([]);
  });

  it("counts a run that was backing off and is due again", () => {
    const working = run("working", { status: "leased" });
    const due = run("due", { wakeAt: new Date(NOW.getTime() - 1000) });
    expect(planQueue(snapshot({ runs: [working, due] })).map((item) => item.id)).toEqual(["due"]);
  });

  it("does not wait for itself", () => {
    const only = run("only", { status: "running" });
    expect(planQueue(snapshot({ runs: [only] }))).toEqual([]);
  });

  it("names a routine it waits for only to the routine's owner", () => {
    const routine = (userId: string) =>
      run("routine", { status: "running", trigger: "routine", routineName: "Weekly sums", userId });
    const waiting = run("waiting");
    expect(planQueue(snapshot({ runs: [routine(ME), waiting] }))[0]?.waitingFor).toBe(
      "Weekly sums",
    );
    expect(planQueue(snapshot({ runs: [routine(OTHER), waiting] }))[0]?.waitingFor).toBeNull();
  });

  it("does not name a run of the caller's that is not a routine", () => {
    const busy = run("busy", { status: "running", routineName: "Not a routine run" });
    expect(planQueue(snapshot({ runs: [busy, run("waiting")] }))[0]?.waitingFor).toBeNull();
  });
});

describe("a run waiting for a computer another bot holds", () => {
  const later = new Date(NOW.getTime() + 30_000);
  const lease = (holder: QueueRun | null, botId = "bot-2") => ({
    computerId: "computer-1",
    botId,
    run: holder,
  });

  it("is in line while a bot sharing the computer holds it, and comes before its own timer", () => {
    const waiting = run("waiting", { wakeAt: later });
    const holder = run("holder", { botId: "bot-2", status: "running", userId: OTHER });
    const items = planQueue(snapshot({ runs: [waiting], leases: [lease(holder)] }));
    expect(items).toEqual([
      {
        id: "waiting",
        kind: "run",
        botId: "bot-1",
        position: 1,
        mine: true,
        reason: "computer_busy",
        waitingFor: null,
        label: null,
      },
    ]);
  });

  it("names the holder's routine to its owner, and a lease with no run is no one's", () => {
    const waiting = run("waiting", { wakeAt: later });
    const holder = run("holder", {
      botId: "bot-2",
      status: "running",
      trigger: "routine",
      routineName: "Nightly backup",
    });
    expect(planQueue(snapshot({ runs: [waiting], leases: [lease(holder)] }))[0]?.waitingFor).toBe(
      "Nightly backup",
    );
    expect(
      planQueue(snapshot({ runs: [waiting], leases: [lease(null)] }))[0]?.waitingFor,
    ).toBeNull();
  });

  it("is not in line for a backoff with nothing holding the computer, nor for its own bot's lease", () => {
    const waiting = run("waiting", { wakeAt: later });
    expect(planQueue(snapshot({ runs: [waiting] }))).toEqual([]);
    expect(planQueue(snapshot({ runs: [waiting], leases: [lease(null, "bot-1")] }))).toEqual([]);
  });

  it("is not held by a lease on another bot's computer", () => {
    const waiting = run("waiting", { wakeAt: later });
    const elsewhere = { computerId: "computer-9", botId: "bot-2", run: null };
    expect(planQueue(snapshot({ runs: [waiting], leases: [elsewhere] }))).toEqual([]);
  });
});

describe("a message held behind a run", () => {
  const held = (messageId: string, seq: number, patch = {}) => ({
    messageId,
    botId: "bot-1",
    userId: OTHER,
    seq,
    runId: "blocker" as string | null,
    ...patch,
  });

  it("waits after the whole line when the run it is behind is working", () => {
    const blocker = run("blocker", { status: "running", userId: OTHER });
    const waiting = run("waiting");
    const items = planQueue(
      snapshot({
        runs: [blocker, waiting],
        holding: [blocker],
        held: [held("late", 9), held("early", 4)],
      }),
    );
    expect(items.map((item) => [item.id, item.kind, item.position, item.reason])).toEqual([
      ["waiting", "run", 1, "bot_busy"],
      ["early", "message", 2, "behind_run"],
      ["late", "message", 3, "behind_run"],
    ]);
  });

  it("waits right behind the run it is behind when that run is itself in line", () => {
    const working = run("working", { status: "running" });
    const blocker = run("blocker");
    const after = run("after");
    const items = planQueue(
      snapshot({
        runs: [working, blocker, after],
        holding: [working, blocker],
        held: [held("held-1", 1)],
      }),
    );
    expect(items.map((item) => item.id)).toEqual(["blocker", "held-1", "after"]);
    expect(items.map((item) => item.position)).toEqual([1, 2, 3]);
  });

  it("falls back to the oldest run holding the bot when its own is gone, and is dropped with none", () => {
    const current = run("current", { status: "running" });
    const fallback = planQueue(
      snapshot({
        runs: [current],
        holding: [current],
        held: [held("held-1", 1, { runId: "ended" })],
      }),
    );
    expect(fallback.map((item) => item.id)).toEqual(["held-1"]);
    expect(planQueue(snapshot({ held: [held("held-1", 1)], holding: [] }))).toEqual([]);
  });

  it("names the run it waits for only when the caller's routine", () => {
    const routine = (userId: string) =>
      run("blocker", { status: "running", trigger: "routine", routineName: "Inbox sweep", userId });
    const waitingFor = (blocker: QueueRun) =>
      planQueue(snapshot({ runs: [blocker], holding: [blocker], held: [held("m", 1)] }))[0]
        ?.waitingFor;
    expect(waitingFor(routine(ME))).toBe("Inbox sweep");
    expect(waitingFor(routine(OTHER))).toBeNull();
  });

  it("keeps a line for each bot, numbered from 1", () => {
    const a = run("a-working", { status: "running" });
    const b = run("b-working", { botId: "bot-2", status: "running" });
    const items = planQueue(
      snapshot({
        bots: [
          { id: "bot-1", computerId: null },
          { id: "bot-2", computerId: null },
        ],
        runs: [a, b, run("a-wait"), run("b-wait", { botId: "bot-2" })],
      }),
    );
    expect(items.map((item) => [item.botId, item.id, item.position])).toEqual([
      ["bot-1", "a-wait", 1],
      ["bot-2", "b-wait", 1],
    ]);
  });
});

describe("what a person may read about waiting work", () => {
  it("gives a label for the caller's own work only", () => {
    const working = run("working", { status: "running" });
    const mine = run("mine", { sourceMessageId: "m-mine" });
    const theirs = run("theirs", { userId: OTHER, sourceMessageId: "m-theirs" });
    const routine = run("routine", { trigger: "routine", routineName: "Daily recap" });
    const previews = new Map([
      ["m-mine", "Plan the trip"],
      ["m-theirs", "Their private words"],
    ]);
    const items = planQueue(snapshot({ runs: [working, mine, theirs, routine], previews }));
    expect(items.map((item) => [item.id, item.mine, item.label])).toEqual([
      ["mine", true, "Plan the trip"],
      ["theirs", false, null],
      ["routine", true, "Daily recap"],
    ]);
  });

  it("never shows another person's routine name, even when a preview exists for it", () => {
    const working = run("working", { status: "running" });
    const theirs = run("theirs", {
      userId: OTHER,
      trigger: "routine",
      routineName: "Their routine",
      sourceMessageId: "m-theirs",
    });
    const items = planQueue(
      snapshot({ runs: [working, theirs], previews: new Map([["m-theirs", "words"]]) }),
    );
    expect(JSON.stringify(items)).not.toContain("Their routine");
    expect(JSON.stringify(items)).not.toContain("words");
  });

  it("gives no words for the caller's own run in another conversation", () => {
    const working = run("working", { status: "running" });
    const elsewhere = run("elsewhere", { threadId: "thread-2", sourceMessageId: "m-else" });
    const items = planQueue(
      snapshot({ runs: [working, elsewhere], previews: new Map([["m-else", "words"]]) }),
    );
    expect(items[0]).toMatchObject({ mine: true, label: null });
  });

  it("labels the caller's own held message and no one else's", () => {
    const blocker = run("blocker", { status: "running" });
    const items = planQueue(
      snapshot({
        runs: [blocker],
        holding: [blocker],
        held: [
          { messageId: "mine", botId: "bot-1", userId: ME, seq: 1, runId: "blocker" },
          { messageId: "theirs", botId: "bot-1", userId: OTHER, seq: 2, runId: "blocker" },
        ],
        previews: new Map([
          ["mine", "my words"],
          ["theirs", "their words"],
        ]),
      }),
    );
    expect(items.map((item) => [item.id, item.mine, item.label])).toEqual([
      ["mine", true, "my words"],
      ["theirs", false, null],
    ]);
  });

  it("leaves the label empty when the caller's own words are not known", () => {
    const blocker = run("blocker", { status: "running" });
    const items = planQueue(
      snapshot({
        runs: [blocker],
        holding: [blocker],
        held: [{ messageId: "mine", botId: "bot-1", userId: ME, seq: 1, runId: "blocker" }],
      }),
    );
    expect(items[0]?.label).toBeNull();
  });
});

describe("queueLabel", () => {
  it("puts the first words on one line and cuts a long one", () => {
    expect(queueLabel("  Plan\n the   trip ")).toBe("Plan the trip");
    expect(queueLabel("x".repeat(200))).toHaveLength(80);
    expect(queueLabel("x".repeat(200))?.endsWith("…")).toBe(true);
  });

  it("gives nothing for blank text", () => {
    expect(queueLabel(" \n ")).toBeNull();
  });
});
