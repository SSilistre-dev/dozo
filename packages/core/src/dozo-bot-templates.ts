import type { BotTemplate } from "@rakazo/contracts";
import {
  DOZO_MEETING_PREP_INSTRUCTIONS,
  DOZO_MEETING_PREP_NAME,
  DOZO_MEETING_PREP_ROUTINE_NAME,
  DOZO_MEETING_PREP_ROUTINE_PROMPT,
  DOZO_MEETING_PREP_SAMPLE,
  DOZO_MEETING_PREP_SKILL_BODY,
  DOZO_MEETING_PREP_SKILL_DESCRIPTION,
  DOZO_MEETING_PREP_SUMMARY,
} from "./dozo-meeting-prep.prompt.js";
import {
  DOZO_NIGHT_NOTES_INSTRUCTIONS,
  DOZO_NIGHT_NOTES_NAME,
  DOZO_NIGHT_NOTES_ROUTINE_NAME,
  DOZO_NIGHT_NOTES_ROUTINE_PROMPT,
  DOZO_NIGHT_NOTES_SAMPLE,
  DOZO_NIGHT_NOTES_SKILL_BODY,
  DOZO_NIGHT_NOTES_SKILL_DESCRIPTION,
  DOZO_NIGHT_NOTES_SUMMARY,
} from "./dozo-night-notes.prompt.js";

/** The fork's ready-made bots, added after upstream's list. Same rules: bump `version` on any change. */
export const DOZO_BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    id: "meeting-prep",
    version: 1,
    name: DOZO_MEETING_PREP_NAME,
    summary: DOZO_MEETING_PREP_SUMMARY,
    sample: DOZO_MEETING_PREP_SAMPLE,
    description: "Meeting prep",
    instructions: DOZO_MEETING_PREP_INSTRUCTIONS,
    skills: [
      {
        name: DOZO_MEETING_PREP_NAME,
        description: DOZO_MEETING_PREP_SKILL_DESCRIPTION,
        body: DOZO_MEETING_PREP_SKILL_BODY,
      },
    ],
    routines: [
      {
        name: DOZO_MEETING_PREP_ROUTINE_NAME,
        prompt: DOZO_MEETING_PREP_ROUTINE_PROMPT,
        crons: ["0 7 * * 1-5"],
      },
    ],
    apps: ["googlecalendar"],
  },
  {
    id: "night-notes",
    version: 1,
    name: DOZO_NIGHT_NOTES_NAME,
    summary: DOZO_NIGHT_NOTES_SUMMARY,
    sample: DOZO_NIGHT_NOTES_SAMPLE,
    description: "Memory tidy-up",
    instructions: DOZO_NIGHT_NOTES_INSTRUCTIONS,
    skills: [
      {
        name: DOZO_NIGHT_NOTES_NAME,
        description: DOZO_NIGHT_NOTES_SKILL_DESCRIPTION,
        body: DOZO_NIGHT_NOTES_SKILL_BODY,
      },
    ],
    routines: [
      {
        name: DOZO_NIGHT_NOTES_ROUTINE_NAME,
        prompt: DOZO_NIGHT_NOTES_ROUTINE_PROMPT,
        crons: ["0 3 * * *"],
      },
    ],
    apps: [],
  },
];
