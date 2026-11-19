import { rpc } from "../../lib/rpc";
import { enqueueTeachComputerInput } from "./teach-computer-input-chain";

/** The most keys one request carries (the server's limit). */
const MAX_KEYS = 200;

type Batch = { botId: string; keys: string[]; sent: boolean };

/** Per bot, the batch still taking keys: the last thing queued for that bot. */
const open = new Map<string, Batch>();
/** Batches queued and not yet sent, oldest first. */
const unsent: Batch[] = [];

function send(batch: Batch, keepalive: boolean) {
  batch.sent = true;
  unsent.splice(unsent.indexOf(batch), 1);
  return rpc.dozoTeach.keys(
    { botId: batch.botId, keys: batch.keys },
    keepalive ? { context: { keepalive: true } } : undefined,
  );
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
    const next: Batch = { botId, keys: [], sent: false };
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
 * The page is going away: the keys queued and not yet sent go now, in order, on requests that
 * outlive the page, so the last text typed is not lost.
 */
export function sendTeachKeysNow(): void {
  open.clear();
  for (const batch of [...unsent]) void send(batch, true);
}
