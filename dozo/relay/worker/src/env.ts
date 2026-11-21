import type { Channel } from "./channel.js";
import type { Registry } from "./registry.js";

export type Env = {
  CHANNELS: DurableObjectNamespace<Channel>;
  REGISTRY: DurableObjectNamespace<Registry>;
  REGISTER_LIMIT: RateLimit;
  ACCESS_LIMIT: RateLimit;
  MAX_CHANNELS?: string;
  PENDING_PER_SOURCE?: string;
  CHANNELS_PER_SOURCE_PER_DAY?: string;
  /** A secret (`wrangler secret put ADMIN_TOKEN`): who may read the counters. Unset: nobody. */
  ADMIN_TOKEN?: string;
  IDLE_DAYS?: string;
  CHANNEL_ATTEMPTS_PER_MINUTE?: string;
  CHANNEL_MESSAGES_PER_MINUTE?: string;
  CHANNEL_BYTES_PER_MINUTE?: string;
};

const DAY = 24 * 60 * 60 * 1000;
/** The protocol lets a relay forget an idle channel only after 90 days. */
const MIN_IDLE_DAYS = 90;

/** The settings in `wrangler.jsonc`, read with the same defaults when one is missing. */
export function settings(env: Env) {
  return {
    maxChannels: count(env.MAX_CHANNELS, 10_000),
    pendingPerSource: count(env.PENDING_PER_SOURCE, 10),
    channelsPerSourceDaily: count(env.CHANNELS_PER_SOURCE_PER_DAY, 30),
    idleMs: Math.max(MIN_IDLE_DAYS, count(env.IDLE_DAYS, 180)) * DAY,
    attemptsPerMinute: count(env.CHANNEL_ATTEMPTS_PER_MINUTE, 60),
    messagesPerMinute: count(env.CHANNEL_MESSAGES_PER_MINUTE, 3000),
    bytesPerMinute: count(env.CHANNEL_BYTES_PER_MINUTE, 128 * 1024 * 1024),
  };
}

function count(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return value !== undefined && value !== "" && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : fallback;
}
