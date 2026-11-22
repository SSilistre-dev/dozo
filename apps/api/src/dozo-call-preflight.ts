import {
  dozoBotModelEndpoint,
  dozoUnansweredEndpoints,
  dozoVoiceServerEndpoints,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { deadlineSignal, withAbort } from "@rakazo/core";
import { mayUsePrivateEndpoint } from "./mcp-servers.js";
import type { RouterContext } from "./routes/context.js";
import { catalogEntry, loadDefaultVoiceCredential } from "./voice.js";

/**
 * Longest the whole check takes, finding the voice and the model included. The addresses get
 * two seconds of it (`CALL_CHECK_MS`); the page waits a little longer than this one.
 */
export const CALL_CHECK_TOTAL_MS = 3_000;

const NOT_CHECKED = { checked: false, refusal: null, serverDictation: false } as const;

/**
 * Before a call rings: whether the speech server and the bot's model answer. Only a deployment
 * that may reach private addresses asks, so a hosted one answers `checked: false` without a
 * request and the call starts as it always did. Nothing is kept: each call asks again.
 */
export function dozoCallPreflightRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  async function check(actor: Actor, botId: string, signal: AbortSignal) {
    const [voice, model] = await Promise.all([
      loadDefaultVoiceCredential(deps, actor, undefined, signal),
      dozoBotModelEndpoint({ prisma: deps.prisma, secretStore: deps.secrets }, actor, botId),
    ]);
    // A hosted speech provider has no address of its own to ask.
    const server = voice ? dozoVoiceServerEndpoints(voice.apiKey) : undefined;
    const unanswered = await dozoUnansweredEndpoints(
      { ...server, model },
      deps.modelConnectionFetch,
      signal,
    );
    return {
      checked: true,
      refusal: unanswered.some((kind) => kind !== "model")
        ? ("speech" as const)
        : unanswered.length > 0
          ? ("model" as const)
          : null,
      serverDictation: Boolean(server && voice && catalogEntry(voice.cred.provider)?.transcribe),
    };
  }

  return {
    dozoCallPreflight: {
      check: authed.dozoCallPreflight.check.handler(async ({ context, input }) => {
        if (!mayUsePrivateEndpoint(deps)) return NOT_CHECKED;
        const total = deadlineSignal(CALL_CHECK_TOTAL_MS, context.signal);
        try {
          return await withAbort(check(context.actor, input.botId, total), total);
        } catch (error) {
          // The check's own delay never stops a call: out of time, nothing was checked.
          if (total.aborted && !context.signal?.aborted) return NOT_CHECKED;
          throw error;
        }
      }),
    },
  };
}
