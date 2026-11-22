import {
  dozoBotModelEndpoint,
  dozoUnansweredEndpoints,
  dozoVoiceServerEndpoints,
} from "@rakazo/adapters";
import { mayUsePrivateEndpoint } from "./mcp-servers.js";
import type { RouterContext } from "./routes/context.js";
import { catalogEntry, loadDefaultVoiceCredential } from "./voice.js";

/**
 * Before a call rings: whether the speech server and the bot's model answer. Only a deployment
 * that may reach private addresses asks, so a hosted one answers `checked: false` without a
 * request and the call starts as it always did. Nothing is kept: each call asks again.
 */
export function dozoCallPreflightRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoCallPreflight: {
      check: authed.dozoCallPreflight.check.handler(async ({ context, input }) => {
        if (!mayUsePrivateEndpoint(deps)) {
          return { checked: false, refusal: null, serverDictation: false };
        }
        const { actor, signal } = context;
        const [voice, model] = await Promise.all([
          loadDefaultVoiceCredential(deps, actor, undefined, signal),
          dozoBotModelEndpoint(
            { prisma: deps.prisma, secretStore: deps.secrets },
            actor,
            input.botId,
          ),
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
          serverDictation: Boolean(
            server && voice && catalogEntry(voice.cred.provider)?.transcribe,
          ),
        };
      }),
    },
  };
}
