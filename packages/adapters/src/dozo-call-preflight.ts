import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { SecretStore } from "@rakazo/adapter-kit";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { resolveMemberMainModel, selectConfiguredModel } from "./models/model-roles.js";
import { parseModelSecret } from "./models/model-secret.js";
import { findConnectedModelCredential, loadStoredModelSecret } from "./models/model-selection.js";
import {
  assertAllowedOpenAiCompatibleRequestUrl,
  normalizeOpenAiCompatibleBaseUrl,
} from "./models/endpoints/openai-compatible-url.js";
import { parseOpenAiCompatibleVoiceSecret } from "./providers/voice/openai-compatible/openai-compatible-voice.js";
import { createOpenAiCompatibleFetch } from "./runtime/pi/models/pi-openai-compatible-provider.js";

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

let registryAddresses: Map<string, string | undefined> | undefined;

/**
 * The one address the model registry gives a provider's models, or undefined when it gives none
 * the check can ask: no address (the SDK builds it, as for a cloud region), an address with a
 * placeholder in it (an account-scoped one), several addresses, or one that is not https.
 */
export function dozoProviderAddress(provider: string): string | undefined {
  if (!registryAddresses) {
    registryAddresses = new Map();
    for (const entry of builtinModels().getProviders()) {
      const urls = new Set(
        entry
          .getModels()
          .flatMap((model) => (model.baseUrl ? [model.baseUrl.trim().replace(/\/+$/, "")] : [])),
      );
      const [only] = urls;
      registryAddresses.set(
        entry.id,
        urls.size === 1 && only && httpsAddress(only) ? only : undefined,
      );
    }
  }
  return registryAddresses.get(canonicalPiProviderId(provider));
}

function httpsAddress(address: string): boolean {
  if (address.includes("{") || address.includes("}")) return false;
  try {
    const url = new URL(address);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * The address the bot's model runs at, resolved as a run resolves it: the connection's own address
 * for a server the person added, the registry's for any other provider. Undefined when there is
 * none to ask (no model connected, a deployment-managed model, or see `dozoProviderAddress`).
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
      : dozoProviderAddress(credential.provider);
  } catch {
    // A secret that does not parse is the run's to report; there is no address to ask here.
    return undefined;
  }
}

/** Longest the whole check waits: a server that is running answers at once. */
export const CALL_CHECK_MS = 2_000;

/** Private addresses are asked here (the caller allows them); public ones as the server allows. */
const ASK_POLICY = { allowPrivate: true };

/**
 * A redirect is an answer: the server is up, and the check does not follow it. The fetch refuses
 * redirects (`redirect: "error"`) with a network-looking TypeError whose cause says so; that is
 * told apart from a refused connection by the cause's message, which a test holds against a real
 * server.
 */
function redirected(error: unknown): boolean {
  return error instanceof Error && error.cause instanceof Error
    ? error.cause.message === "unexpected redirect"
    : false;
}

/** Whether the server's own settings let this address be asked at all. */
function mayAsk(address: string): boolean {
  try {
    assertAllowedOpenAiCompatibleRequestUrl(address, ASK_POLICY);
    return true;
  } catch {
    return false;
  }
}

/**
 * The kinds whose address did not answer within `CALL_CHECK_MS` in all, asked together. A kind
 * with no address is not asked, and neither is one the server's settings do not allow (a public
 * address where public hosts are off): it counts as answering. Private addresses are reachable
 * here, so the caller decides that before asking.
 */
export async function dozoUnansweredEndpoints(
  endpoints: CallEndpoints,
  fetchImpl?: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<CallEndpointKind[]> {
  const until = deadlineSignal(CALL_CHECK_MS, signal);
  const safeFetch = createOpenAiCompatibleFetch(fetchImpl, undefined, ASK_POLICY);
  const asked = (Object.entries(endpoints) as [CallEndpointKind, string][]).filter(
    ([, address]) => address && mayAsk(address),
  );
  const answers = await Promise.allSettled(
    asked.map(async ([, address]) => {
      try {
        const response = await safeFetch(`${address}/models`, {
          headers: { accept: "application/json" },
          signal: until,
        });
        await response.body?.cancel();
      } catch (error) {
        if (!redirected(error)) throw error;
      }
    }),
  );
  signal?.throwIfAborted();
  return asked.flatMap(([kind], index) => (answers[index]?.status === "rejected" ? [kind] : []));
}
