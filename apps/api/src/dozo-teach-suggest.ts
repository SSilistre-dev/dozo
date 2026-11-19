import { randomUUID } from "node:crypto";
import type {
  AgentInputImage,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { modelAcceptsImageInput } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { deadlineSignal, teachInputName } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recordUsage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";
import {
  teachValueSuggestionInstructions,
  teachValueSuggestionPrompt,
} from "./dozo-teach-suggest.prompt.js";

const SUGGEST_TIMEOUT_MS = 8_000;
const MAX_VALUE_CHARS = 200;

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;

/**
 * A suggestion per placeholder: an input name, and whether the value looks like a secret. Whether
 * it changes from run to run only helps the model name it: every value is an input by default.
 */
export type TeachValueSuggestions = Record<string, { name: string; secret: boolean }>;

export type TeachValueSuggester = (
  actor: Actor,
  skill: { botId: string; goal: string },
  values: Array<{ placeholder: string; text: string }>,
) => Promise<TeachValueSuggestions | null>;

const Answer = z.array(
  z.object({ placeholder: z.string(), name: z.string(), secret: z.boolean() }),
);

function parseAnswer(text: string, placeholders: Set<string>): TeachValueSuggestions | null {
  const parsed = Answer.safeParse(jsonArrayIn(text));
  if (!parsed.success) return null;
  const suggestions: TeachValueSuggestions = {};
  for (const entry of parsed.data) {
    const name = teachInputName(entry.name);
    // A secret is kept as one even without a usable name.
    if (!placeholders.has(entry.placeholder) || (!name && !entry.secret)) continue;
    suggestions[entry.placeholder] = { name, secret: entry.secret };
  }
  return suggestions;
}

/** What a short teaching call to the bot's own model needs from the server. */
export type TeachModelDeps = {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  resolveModel: (scope: {
    userId: string;
    spaceId: string;
    botId: string;
  }) => Promise<AgentRunRequest["model"]>;
};

/**
 * One short call to the bot's own model connection with no tools, history or thinking, its usage
 * recorded as setup. Null when there is no model to ask, or it cannot see the images given;
 * throws when the call fails or runs out of time.
 */
export async function askTeachModel(
  deps: TeachModelDeps,
  actor: Actor,
  botId: string,
  request: { prompt: string; instructions: string; images?: AgentInputImage[] },
  timeoutMs: number,
): Promise<string | null> {
  const scope = { userId: actor.userId, spaceId: actor.spaceId, botId };
  const id = `teach-${randomUUID()}`;
  // Usage kinds are a fixed set; an auxiliary call like this one counts as setup.
  const record = async (event: UsageEvent) => {
    await recordUsage(deps.prisma, event, { ...scope, operationId: id, operationKind: "setup" });
  };
  const model = await deps.resolveModel(scope);
  // "scripted" means no model is configured; it would echo canned text.
  if (!deps.runtime.describe().capabilities.compaction || model.provider === "scripted") {
    return null;
  }
  const images = request.images?.slice(0, model.maxImagesPerPrompt ?? request.images.length);
  if (
    images &&
    !(images.length && modelAcceptsImageInput(model.provider, model.id, model.acceptsImages))
  ) {
    return null;
  }
  let answer = "";
  for await (const event of deps.runtime.run(
    {
      botId,
      threadId: id,
      runId: id,
      usageOperationKind: "setup",
      onUsage: record,
      prompt: request.prompt,
      instructions: request.instructions,
      history: [],
      tools: [],
      ...(images ? { currentTurnImages: images } : {}),
      model: { ...model, thinkingLevel: "off" },
      allowSilentEmpty: true,
    },
    { operationId: id, traceId: id, ...scope, signal: deadlineSignal(timeoutMs) },
  )) {
    if (event.type === "usage" && !event.accounted) await record(event);
    if (event.type === "done" && event.text) answer = event.text;
  }
  return answer;
}

/** The JSON array in a reply, also when the model wrapped it in a code fence or a sentence. */
export function jsonArrayIn(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Suggests names for the values typed while teaching, with the bot's own model connection and no
 * tools. Only the values given are sent: the caller leaves secret ones out. Null when no model
 * call could be made or its answer was unusable; the review then simply has no suggestions.
 */
export function createTeachValueSuggester(deps: TeachModelDeps): TeachValueSuggester {
  return async (actor, skill, values) => {
    if (!values.length) return {};
    try {
      const answer = await askTeachModel(
        deps,
        actor,
        skill.botId,
        {
          prompt: teachValueSuggestionPrompt(
            skill.goal,
            values.map((value) => ({ ...value, text: value.text.slice(0, MAX_VALUE_CHARS) })),
          ),
          instructions: teachValueSuggestionInstructions(),
        },
        SUGGEST_TIMEOUT_MS,
      );
      if (answer === null) return null;
      return parseAnswer(answer, new Set(values.map((value) => value.placeholder)));
    } catch (error) {
      getLogger().warn("teach value suggestion failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
}
