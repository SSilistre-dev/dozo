import type { PrismaClient } from "@rakazo/db";

/**
 * The reminders the "Meeting prep" template's skill makes are the one place calendar-derived text
 * could reach a routine's prompt, and anyone can send an invite. So a reminder named like one
 * is held to the shape the skill gives: one-time, an id and a time in a fixed sentence, and no
 * more of them waiting than two days of meetings. The skill asks for at most eight a day; this
 * limit is the code's.
 */
export const DOZO_MEETING_PREP_PREFIX = "Meeting prep ";
export const DOZO_MEETING_PREP_MAX_WAITING = 16;

const EVENT_ID = "[A-Za-z0-9_=.@-]{1,128}";
const START = String.raw`\d{4}-\d{2}-\d{2}T[\d:.]{5,12}(?:Z|[+-]\d{2}:\d{2})`;
const PROMPT = new RegExp(
  `^Write the prep note for calendar event (${EVENT_ID}), which starts at (${START}), with the Meeting prep skill\\.$`,
);

const ONE_TIME_ONLY = ["cron", "every", "unit", "watch", "startAt"] as const;

const given = (value: unknown) =>
  value !== undefined && value !== null && !(typeof value === "string" && !value.trim());

/** Why a schedule_create call named like a meeting-prep reminder cannot be saved, if it cannot. */
export async function dozoMeetingPrepRefusal(
  prisma: Pick<PrismaClient, "routine">,
  input: {
    spaceId: string;
    botId: string;
    name: string;
    prompt: string;
    schedule: Record<string, unknown>;
  },
): Promise<string | undefined> {
  const name = input.name.trim();
  if (!name.startsWith(DOZO_MEETING_PREP_PREFIX)) return undefined;
  const id = name.slice(DOZO_MEETING_PREP_PREFIX.length);
  const matched = PROMPT.exec(input.prompt.trim());
  if (!new RegExp(`^${EVENT_ID}$`).test(id) || !matched || matched[1] !== id)
    return `A "${DOZO_MEETING_PREP_PREFIX}<event id>" reminder's prompt is exactly: Write the prep note for calendar event <event id>, which starts at <start time>, with the Meeting prep skill. Nothing else from the calendar goes in a name or prompt.`;
  if (ONE_TIME_ONLY.some((key) => given(input.schedule[key])))
    return "A meeting prep reminder is a one-time reminder for the meeting's start.";
  const waiting = await prisma.routine.count({
    where: {
      spaceId: input.spaceId,
      botId: input.botId,
      active: true,
      name: { startsWith: DOZO_MEETING_PREP_PREFIX },
    },
  });
  return waiting >= DOZO_MEETING_PREP_MAX_WAITING
    ? `${DOZO_MEETING_PREP_MAX_WAITING} meeting prep reminders are already waiting. Skip the rest.`
    : undefined;
}
