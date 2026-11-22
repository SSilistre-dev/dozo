import type { SecretStore } from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { resolveMemberMainModel, selectConfiguredModel } from "./model-roles.js";
import { parseModelSecret } from "./model-secret.js";
import { findConnectedModelCredential, loadStoredModelSecret } from "./model-selection.js";
import { normalizeOpenAiCompatibleBaseUrl } from "./openai-compatible-url.js";
import { parseOpenAiCompatibleVoiceSecret } from "./openai-compatible-voice.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";

/**
 * The check before a call starts: do the places a call needs answer right now. It never makes a
 * model call and never sends a key; a server that answers with any status, an error included, is
 * up. Only a server that refuses the connection or stays silent is not.
 */

/** What a call needs: the voice the bot speaks with, the one it hears with, its model. */
export type CallEndpointKind = "speech" | "transcription" | "model";

export type CallEndpoints = Partial<Record<CallEndpointKind, string>>;

/** The addresses of a self-hosted speech server, read from its saved secret. */
export function dozoVoiceServerEndpoints(
  plaintext: string,
): Pick<CallEndpoints, "speech" | "transcription"> | undefined {
  try {
    const secret = parseOpenAiCompatibleVoiceSecret(plaintext);
    const speech = normalizeOpenAiCompatibleBaseUrl(secret.baseUrl);
    return {
      speech,
      transcription: secret.sttBaseUrl
        ? normalizeOpenAiCompatibleBaseUrl(secret.sttBaseUrl)
        : speech,
    };
  } catch {
    // Not a self-hosted server's secret (a hosted provider's key, or an unreadable one).
    return undefined;
  }
}

/**
 * The address the bot's model runs at, resolved as a run resolves it. Undefined when the model
 * has no address of its own to ask: a hosted provider, or no model connected.
 */
export async function dozoBotModelEndpoint(
  deps: { prisma: PrismaClient; secretStore: Pick<SecretStore, "load"> },
  scope: { userId: string; spaceId: string },
  botId: string,
): Promise<string | undefined> {
  const override = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: scope.spaceId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  const [overrideCredential, main] = await Promise.all([
    override?.modelProvider && override.modelId
      ? findConnectedModelCredential(
          deps.prisma,
          deps.secretStore,
          scope,
          override.modelProvider,
          override.modelId,
        )
      : Promise.resolve(null),
    resolveMemberMainModel(deps, scope),
  ]);
  const { credential } = selectConfiguredModel({
    override,
    overrideCredential,
    main,
    defaults: {},
  });
  if (!credential) return undefined;
  const loaded = await loadStoredModelSecret(
    deps.prisma,
    deps.secretStore,
    scope.userId,
    credential.secretId,
  );
  if (loaded.status !== "loaded") return undefined;
  try {
    const secret = parseModelSecret(loaded.plaintext);
    return secret.kind === "openai_compatible"
      ? normalizeOpenAiCompatibleBaseUrl(secret.baseUrl)
      : undefined;
  } catch {
    // A secret that does not parse is the run's to report; there is no address to ask here.
    return undefined;
  }
}

/** Longest the whole check waits: a server that is running answers at once. */
export const CALL_CHECK_MS = 2_000;

/**
 * The kinds whose address did not answer within `CALL_CHECK_MS` in all, asked together. A kind
 * with no address is not asked. Private addresses are reachable here, so the caller decides that
 * before asking.
 */
export async function dozoUnansweredEndpoints(
  endpoints: CallEndpoints,
  fetchImpl?: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<CallEndpointKind[]> {
  const until = deadlineSignal(CALL_CHECK_MS, signal);
  const safeFetch = createOpenAiCompatibleFetch(fetchImpl, undefined, { allowPrivate: true });
  const asked = (Object.entries(endpoints) as [CallEndpointKind, string][]).filter(
    ([, address]) => address,
  );
  const answers = await Promise.allSettled(
    asked.map(async ([, address]) => {
      const response = await safeFetch(`${address}/models`, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: until,
      });
      await response.body?.cancel();
    }),
  );
  signal?.throwIfAborted();
  return asked.flatMap(([kind], index) => (answers[index]?.status === "rejected" ? [kind] : []));
}
