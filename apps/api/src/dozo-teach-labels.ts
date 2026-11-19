import type { Actor } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";
import { teachClickLabelInstructions, teachClickLabelPrompt } from "./dozo-teach-labels.prompt.js";
import type { TeachModelDeps } from "./dozo-teach-suggest.js";
import { askTeachModel, jsonArrayIn } from "./dozo-teach-suggest.js";

const LABEL_TIMEOUT_MS = 10_000;
/** Pictures sent in one call; clicks past these keep their window and coordinate only. */
const MAX_PICTURES = 20;
const LABEL_MAX = 60;

/**
 * A model's label made plain, as the teacher may keep it: one line, no input braces, quotes or
 * control characters, at most 60 characters.
 */
export function teachClickLabel(text: string): string {
  return text
    .replace(/[\p{Cc}{}"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LABEL_MAX)
    .trim();
}

/** A label per target id: what was clicked, in a few words. */
export type TeachClickLabels = Record<string, string>;

export type TeachClickLabeller = (
  actor: Actor,
  skill: { botId: string; goal: string },
  pictures: Array<{ id: string; image: string }>,
) => Promise<TeachClickLabels | null>;

const Answer = z.array(z.object({ id: z.string(), label: z.string() }));

/**
 * Names what each recorded click hit, from the pictures around the clicks, with the bot's own
 * model connection. Null when no call could be made (no model, or one that cannot see pictures),
 * it failed, or its answer was unusable: the steps then keep the window and the coordinate.
 */
export function createTeachClickLabeller(deps: TeachModelDeps): TeachClickLabeller {
  return async (actor, skill, pictures) => {
    const offered = pictures.slice(0, MAX_PICTURES);
    if (!offered.length) return {};
    // The ones the model takes in one prompt; the prompt names exactly those, in order.
    let sent: string[] = [];
    try {
      const answer = await askTeachModel(
        deps,
        actor,
        skill.botId,
        {
          prompt: (count) => {
            sent = offered.slice(0, count).map((picture) => picture.id);
            return teachClickLabelPrompt(skill.goal, sent);
          },
          instructions: teachClickLabelInstructions(),
          images: offered.map((picture) => ({
            name: `click-${picture.id}.webp`,
            mimeType: "image/webp",
            data: Buffer.from(picture.image, "base64"),
          })),
        },
        LABEL_TIMEOUT_MS,
      );
      if (answer === null) return null;
      const parsed = Answer.safeParse(jsonArrayIn(answer));
      if (!parsed.success) return null;
      // An answer about a picture the model never got is made up.
      const ids = new Set(sent);
      const labels: TeachClickLabels = {};
      for (const entry of parsed.data) {
        const label = teachClickLabel(entry.label);
        if (ids.has(entry.id) && label) labels[entry.id] = label;
      }
      return labels;
    } catch (error) {
      getLogger().warn("teach click labels failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
}
