import { rpc } from "../../lib/rpc";
import { enqueueTeachComputerInput } from "./teach-computer-input-chain";

/** The most keys one request carries (the server's limit). */
const MAX_KEYS = 200;

/** This page, so the server tells its batches apart from another page's. */
const PAGE = crypto.randomUUID();

type Batch = { botId: string; keys: string[]; sent: boolean; seq: number };

/** Per bot, the batch still taking keys: the last thing queued for that bot. */
const open = new Map<string, Batch>();
/** Batches queued and not yet sent, oldest first. */
const unsent: Batch[] = [];
/** Per bot, the last batch number given. */
const numbered = new Map<string, number>();
/** Per bot, the last batch sent that has no answer yet. */
const unanswered = new Map<string, number>();

/**
 * Sends a batch numbered in the order it was queued. One sent while the batch before it has no
 * answer yet (only as the page goes away) names that one, and the server types and records it
 * only after that one, so neither overtakes the other.
 */
function send(batch: Batch, keepalive: boolean) {
  batch.sent = true;
  unsent.splice(unsent.indexOf(batch), 1);
  const after = unanswered.get(batch.botId);
  unanswered.set(batch.botId, batch.seq);
  return rpc.dozoTeach
    .keys(
      {
        botId: batch.botId,
        keys: batch.keys,
        order: { page: PAGE, seq: batch.seq, ...(after ? { after } : {}) },
      },
      keepalive ? { context: { keepalive: true } } : undefined,
    )
    .finally(() => {
      if (unanswered.get(batch.botId) === batch.seq) unanswered.delete(batch.botId);
    });
}

/**
 * Queues a key typed on the bot's computer. Keys typed in a row ride one request: a key joins
 * the batch queued last for the bot until that batch starts sending, so while one request is in
 * flight the next keys gather behind it, in order. Anything else queued for the bot (a click, a
 * scroll, protected input) must call `closeTeachKeys` first, so no key overtakes it.
 */
export function queueTeachKey(botId: string, key: string): void {
  let batch = open.get(botId);
  if (!batch || batch.keys.length >= MAX_KEYS) {
    const seq = (numbered.get(botId) ?? 0) + 1;
    numbered.set(botId, seq);
    const next: Batch = { botId, keys: [], sent: false, seq };
    batch = next;
    open.set(botId, next);
    unsent.push(next);
    void enqueueTeachComputerInput(botId, async () => {
      if (open.get(botId) === next) open.delete(botId);
      // Sent already as the page went away.
      if (next.sent) return;
      await send(next, false);
    });
  }
  batch.keys.push(key);
}

/** Later keys start a new batch, queued after whatever is queued next. */
export function closeTeachKeys(botId: string): void {
  open.delete(botId);
}

/**
 * The page is going away: the keys queued and not yet sent go now, on requests that outlive the
 * page, so the last text typed is not lost. They may reach the server before a batch still on its
 * way, so each names the batch before it, and the server keeps their order.
 */
export function sendTeachKeysNow(): void {
  open.clear();
  for (const batch of [...unsent]) void send(batch, true);
}
