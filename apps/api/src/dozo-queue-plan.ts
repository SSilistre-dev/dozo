import type { DozoQueueItem } from "@rakazo/contracts";
import { compareQueueStart } from "@rakazo/core";

/** A run as the queue reads it: no content, only what decides who waits for whom. */
export interface QueueRun {
  id: string;
  botId: string;
  userId: string;
  status: string;
  trigger: string;
  wakeAt: Date | null;
  createdAt: Date;
  threadId: string;
  /** The routine's name, when the run is a routine's. Shown only to the person it belongs to. */
  routineName: string | null;
  sourceMessageId: string | null;
}

/** A message held until the run ahead of it ends. `runId` is the run it was sent behind. */
export interface QueueHeldMessage {
  messageId: string;
  botId: string;
  userId: string;
  seq: number;
  runId: string | null;
}

export interface QueueSnapshot {
  actorUserId: string;
  /** The conversation being looked at: only there may a message's own words be a label. */
  threadId: string;
  now: Date;
  /** The bots looked at, in the order their lines are returned. */
  bots: Array<{ id: string; computerId: string | null }>;
  /** Their queued, leased and running runs, in every conversation of the Space. */
  runs: QueueRun[];
  /** Runs holding the looked-at conversation's bots: what held messages wait behind. */
  holding: QueueRun[];
  /** Live computer leases on those bots' computers, with the run each belongs to when it has one. */
  leases: Array<{ computerId: string; botId: string; run: QueueRun | null }>;
  held: QueueHeldMessage[];
  /** The start of the caller's own messages, by message id. Nobody else's is ever put here. */
  previews: Map<string, string>;
}

/** The order the next run starts in (`startNextWaitingRun` reads the same one). */
const byStart = compareQueueStart;

/** A routine's name, to the person it belongs to and no one else. */
function ownRoutineName(run: QueueRun | null | undefined, userId: string): string | null {
  return run && run.userId === userId && run.trigger === "routine" ? run.routineName : null;
}

/**
 * Who waits, why, and in what order, per bot. A run is in line only while something stops it:
 * the bot's own other run (it starts when that ends, oldest first) or another bot's hold on a
 * shared computer (it tries again on a timer). A run with nothing in its way is starting, and a
 * run backing off after a failure is not in line. A held message starts after the run it waits
 * behind: right behind it when that run is itself in line, otherwise after the whole line.
 */
export function planQueue(snapshot: QueueSnapshot): DozoQueueItem[] {
  const { actorUserId: me, now } = snapshot;
  const items: DozoQueueItem[] = [];
  for (const bot of snapshot.bots) {
    const own = snapshot.runs.filter((run) => run.botId === bot.id);
    const working = own
      .filter((run) => run.status === "leased" || run.status === "running")
      .sort(byStart);
    const line: Array<{ run: QueueRun; reason: DozoQueueItem["reason"]; ahead: QueueRun | null }> =
      [];
    for (const run of own.filter((candidate) => candidate.status === "queued").sort(byStart)) {
      if (!run.wakeAt || run.wakeAt <= now) {
        const ahead = working.find((other) => other.id !== run.id);
        if (ahead) line.push({ run, reason: "bot_busy", ahead });
        continue;
      }
      const lease = snapshot.leases.find(
        (held) => held.computerId === bot.computerId && held.botId !== bot.id,
      );
      if (lease) line.push({ run, reason: "computer_busy", ahead: lease.run });
    }

    const runItem = (entry: (typeof line)[number]): DozoQueueItem => {
      const mine = entry.run.userId === me;
      const preview = entry.run.threadId === snapshot.threadId && entry.run.sourceMessageId;
      return {
        id: entry.run.id,
        kind: "run",
        botId: bot.id,
        position: 0,
        mine,
        reason: entry.reason,
        waitingFor: ownRoutineName(entry.ahead, me),
        label: mine
          ? (ownRoutineName(entry.run, me) ??
            (preview ? (snapshot.previews.get(preview) ?? null) : null))
          : null,
      };
    };

    const holding = snapshot.holding.filter((run) => run.botId === bot.id).sort(byStart);
    const heldItems = snapshot.held
      .filter((message) => message.botId === bot.id)
      .sort((a, b) => a.seq - b.seq || a.messageId.localeCompare(b.messageId))
      .flatMap((message) => {
        const blocker = holding.find((run) => run.id === message.runId) ?? holding[0];
        if (!blocker) return [];
        const mine = message.userId === me;
        const item: DozoQueueItem = {
          id: message.messageId,
          kind: "message",
          botId: bot.id,
          position: 0,
          mine,
          reason: "behind_run",
          waitingFor: ownRoutineName(blocker, me),
          label: mine ? (snapshot.previews.get(message.messageId) ?? null) : null,
        };
        return [{ item, blockerId: blocker.id }];
      });

    const ordered = line.flatMap((entry) => [
      runItem(entry),
      ...heldItems.filter((held) => held.blockerId === entry.run.id).map((held) => held.item),
    ]);
    const placed = new Set(ordered.map((item) => item.id));
    for (const held of heldItems) if (!placed.has(held.item.id)) ordered.push(held.item);
    for (const [index, item] of ordered.entries()) items.push({ ...item, position: index + 1 });
  }
  return items;
}

/** The first words of a message, on one line, for the person who wrote it. */
export function queueLabel(text: string, max = 80): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
