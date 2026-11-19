import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { TeachTypedValue } from "@rakazo/core";
import { deadlineSignal, teachInputName } from "@rakazo/core";
import type { PrismaClient, TeachValueSuggestions } from "@rakazo/db";
import { recordUsage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";
import {
  teachValueSuggestionInstructions,
  teachValueSuggestionPrompt,
} from "./dozo-teach-suggest.prompt.js";

const SUGGEST_TIMEOUT_MS = 8_000;

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;

/** What the model is told about a skill: no character of any typed value is in it. */
export type TeachSuggestionContext = {
  botId: string;
  goal: string;
  /** The steps as recorded, with placeholders where values were typed. */
  steps: string[];
  /** Window titles seen while teaching that show nothing typed. */
  windowTitles: string[];
};

/** A value as the model is told about it: its placeholder and its shape, never its text. */
export type TeachValueShape = { placeholder: string; shape: string };

export type TeachValueSuggester = (
  actor: Actor,
  skill: TeachSuggestionContext,
  values: TeachValueShape[],
) => Promise<TeachValueSuggestions | null>;

const Answer = z.array(z.object({ placeholder: z.string(), name: z.string() }));

function lengthClass(length: number): string {
  if (length <= 3) return "1-3 characters";
  if (length <= 8) return "4-8 characters";
  if (length <= 20) return "9-20 characters";
  if (length <= 60) return "21-60 characters";
  return "over 60 characters";
}

/**
 * What a value looks like, worked out here so the value itself is never sent: its length class
 * and whether it is digits only, mixes letters and digits, holds an @ or spaces.
 */
export function teachValueShape(value: TeachTypedValue): TeachValueShape {
  return { placeholder: value.placeholder, shape: shapeOf(value) };
}

function shapeOf(value: TeachTypedValue): string {
  if (value.secret) return "protected input";
  if (value.text === null) return "unknown";
  const text = value.text;
  const traits = [lengthClass([...text].length)];
  if (/^\d+$/.test(text)) traits.push("digits only");
  else if (/\p{L}/u.test(text) && /\d/.test(text)) traits.push("letters and digits");
  if (text.includes("@")) traits.push("has @");
  if (/\s/.test(text)) traits.push("has spaces");
  return traits.join(", ");
}

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
    if (placeholders.has(entry.placeholder) && name) suggestions[entry.placeholder] = { name };
  }
  return suggestions;
}

/**
 * Suggests names for the values typed while teaching, with the bot's own model connection and no
 * tools. It is given, and the model gets, the task, the steps with placeholders, window titles
 * that show nothing typed, and each value's shape: never a value. Null when the call failed, timed out or answered
 * nothing usable; the review then simply has no suggestions.
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
      let answer = "";
      for await (const event of deps.runtime.run(
        {
          botId: skill.botId,
          threadId: id,
          runId: id,
          usageOperationKind: "setup",
          onUsage: record,
          prompt: teachValueSuggestionPrompt({
            goal: skill.goal,
            steps: skill.steps,
            windowTitles: skill.windowTitles,
            values,
          }),
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
