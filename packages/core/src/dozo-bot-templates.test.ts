import { BotTemplateSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { extractRoutineSkillMentions } from "./skills/agent-skill.js";
import { BOT_TEMPLATES, findBotTemplate } from "./bots/bot-templates.js";
import { presetFromCron } from "./routines/schedule.js";
import { DOZO_BOT_TEMPLATES } from "./dozo-bot-templates.js";
import {
  DOZO_MEETING_PREP_REMINDER,
  DOZO_MEETING_PREP_SKILL_BODY,
} from "./dozo-meeting-prep.prompt.js";

// The wiring test (the list holds the fork's templates after upstream's) runs on the branded tree:
// an anchored rule spreads DOZO_BOT_TEMPLATES into BOT_TEMPLATES.

describe("the fork's bot templates", () => {
  const prep = DOZO_BOT_TEMPLATES[0]!;

  it("are in the list the apps and the API read, after upstream's", () => {
    expect(findBotTemplate("meeting-prep")).toBe(prep);
    expect(BOT_TEMPLATES.slice(-DOZO_BOT_TEMPLATES.length)).toEqual(DOZO_BOT_TEMPLATES);
    const ids = BOT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("meeting prep is a valid template: one skill, one routine that mentions it, a calendar", () => {
    expect(BotTemplateSchema.parse(prep)).toEqual(prep);
    expect(prep.skills.map((skill) => skill.name)).toEqual(["Meeting prep"]);
    expect(prep.routines).toHaveLength(1);
    expect(extractRoutineSkillMentions(prep.routines[0]!.prompt)).toEqual(["Meeting prep"]);
    expect(prep.apps).toEqual(["googlecalendar"]);
    for (const cron of prep.routines[0]!.crons) {
      expect(presetFromCron(cron).freq).not.toBe("Advanced");
    }
  });

  it("names the reminders the way the skill tells the bot to", () => {
    expect(DOZO_MEETING_PREP_SKILL_BODY).toContain(`"${DOZO_MEETING_PREP_REMINDER} <event id>"`);
  });

  it("night notes is a valid template: one skill its routine mentions, a daily schedule, no apps", () => {
    const night = findBotTemplate("night-notes")!;
    expect(BotTemplateSchema.parse(night)).toEqual(night);
    expect(extractRoutineSkillMentions(night.routines[0]!.prompt)).toEqual(["Night notes"]);
    expect(night.apps).toEqual([]);
    expect(presetFromCron(night.routines[0]!.crons[0]!).freq).toBe("Every day");
  });
});
