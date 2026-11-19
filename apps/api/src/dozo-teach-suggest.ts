import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
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

/** The JSON array in a reply, also when the model wrapped it in a code fence or a sentence. */
function parseAnswer(text: string, placeholders: Set<string>): TeachValueSuggestions | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return null;
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = Answer.safeParse(json);
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

/**
 * Suggests names for the values typed while teaching, with the bot's own model connection and no
 * tools. Only the values given are sent: the caller leaves secret ones out. Null when no model
 * call could be made or its answer was unusable; the review then simply has no suggestions.
 */
export function createTeachValueSuggester(deps: {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  resolveModel: (scope: {
    userId: string;
    spaceId: string;
    botId: string;
  }) => Promise<AgentRunRequest["model"]>;
}): TeachValueSuggester {
  return async (actor, skill, values) => {
    if (!values.length) return {};
    const scope = { userId: actor.userId, spaceId: actor.spaceId, botId: skill.botId };
    const id = `teach-suggest:${randomUUID()}`;
    // Usage kinds are a fixed set; an auxiliary call like this one counts as setup.
    const record = async (event: UsageEvent) => {
      await recordUsage(deps.prisma, event, { ...scope, operationId: id, operationKind: "setup" });
    };
    try {
      const model = await deps.resolveModel(scope);
      // "scripted" means no model is configured; it would echo canned text.
      if (!deps.runtime.describe().capabilities.compaction || model.provider === "scripted") {
        return null;
      }
      let answer = "";
      for await (const event of deps.runtime.run(
        {
          botId: skill.botId,
          threadId: id,
          runId: id,
          usageOperationKind: "setup",
          onUsage: record,
          prompt: teachValueSuggestionPrompt(
            skill.goal,
            values.map((value) => ({ ...value, text: value.text.slice(0, MAX_VALUE_CHARS) })),
          ),
          instructions: teachValueSuggestionInstructions(),
          history: [],
          tools: [],
          model: { ...model, thinkingLevel: "off" },
          allowSilentEmpty: true,
        },
        { operationId: id, traceId: id, ...scope, signal: deadlineSignal(SUGGEST_TIMEOUT_MS) },
      )) {
        if (event.type === "usage" && !event.accounted) await record(event);
        if (event.type === "done" && event.text) answer = event.text;
      }
      return parseAnswer(answer, new Set(values.map((value) => value.placeholder)));
    } catch (error) {
      getLogger().warn("teach value suggestion failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
}
