import type { MessageBlock } from "@rakazo/contracts";
import { containsSecret, deadlineSignal, redactSecrets } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { uncertainEffectResult } from "./approval-effect.js";
import type { DeviceCapability } from "./dozo-device-capabilities.js";
import {
  PHONE_CALENDAR_CREATE_TOOL,
  PHONE_CALENDAR_READ_TOOL,
  PHONE_CONTACTS_SEARCH_TOOL,
  PHONE_LOCATION_TOOL,
  PHONE_REMINDER_CREATE_TOOL,
  PHONE_REMINDERS_READ_TOOL,
  PHONE_TOOL_NAMES,
  PHONE_WRITE_TOOL_NAMES,
} from "./dozo-phone.tool-definition.js";
import {
  calendarCreateInput,
  reminderCreateInput,
  remindersReadDetail,
  remindersReadInput,
} from "./dozo-phone-input.js";
import type {
  PhoneCalendarCreateRequest,
  PhoneCalendarReadRequest,
  PhoneContactField,
  PhoneContactsSearchRequest,
  PhoneLocationPrecision,
  PhoneLocationRequest,
  PhoneReminderCreateRequest,
  PhoneRemindersReadRequest,
} from "./dozo-phone-protocol.js";
import {
  isoInstant,
  PHONE_CALENDAR_MAX_DAYS,
  PHONE_CALENDAR_MAX_EVENTS,
  PHONE_CALENDAR_QUERY_MAX,
  PHONE_CONTACT_FIELDS,
  PHONE_CONTACTS_MAX,
  PHONE_LOCATION_PRECISIONS,
  PHONE_REMINDERS_MAX,
  phoneCalendarCreateValue,
  phoneCalendarValue,
  phoneContactsQuery,
  phoneContactsValue,
  phoneLocationValue,
  phoneReminderCreateValue,
  phoneRemindersValue,
} from "./dozo-phone-protocol.js";
import type { DozoMarkDb } from "./dozo-token-marks.js";
import { dozoBotTokenTainted, runCameByToken } from "./dozo-token-run.js";
import type { ConnectedPhone } from "./dozo-user-device-gateway.js";
import type { RunContext } from "./run-context.js";
import { isRunTainted, markReadOutsideContent } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { USER_DEVICE_OFFLINE_MESSAGE, UserDeviceOfflineError } from "./user-device-gateway.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

/**
 * The user's own phone: its calendar (phone_calendar_read), one person in its contacts
 * (phone_contacts_search), where it is, once (phone_location) and its reminders
 * (phone_reminders_read); and one new event (phone_calendar_create) or reminder
 * (phone_reminder_create) added to it, never one changed or deleted. The phone pairs and connects
 * as a user device (dozo-user-device-gateway.ts) and declares each capability only while its
 * switch is on and the system allows it. Only the person's own chat runs reach it
 * (`userComputerOwner`), never a run a token's message reached. A bot's first read of each kind
 * since its switch was turned on asks, in every approval mode, and every location read and every
 * write asks; calls run one at a time. The effect keeps no content, the turn is kept out of
 * memory, and later turns replay no output (`keptToolCalls` in @rakazo/core).
 */

/** How long the phone has to answer: the device default (ten minutes) is far too long here. */
export const PHONE_ANSWER_MS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const OFFLINE =
  "The user's phone is not connected. Ask them to open the app on their phone, then try again.";
const TIMEOUT = "The user's phone did not answer in time. Ask them to keep the app open.";
const CHANGED = "The user's phone changed since this was approved. Try again.";
const TOKEN_RUN = "The user's phone is not used for a message sent with a token.";
const CALENDAR_ASK = "Let this bot read your phone's calendar?";
const CONTACTS_ASK = "Let this bot look up someone in your phone's contacts?";
const REMINDERS_ASK = "Let this bot read your phone's reminders?";
const EVENT_ASK = "Add this event to your phone's calendar?";
const REMINDER_ASK = "Add this reminder to your phone?";
/** A write's card, first line, when the run read outside content before it asked. */
export const PHONE_WRITE_TAINTED_LINE = "This run read outside content before asking.";
/** A write's card line, after that one, when an earlier write of this run may have been made. */
export const PHONE_WRITE_UNSURE_LINE = "An earlier try may have added this already.";
const SECRET_ON_CARD =
  "This holds a secret of the bot's, which the approval card cannot show. Leave it out.";
const CONTACTS_QUERY =
  "query must be part of one person's name, with at least two letters or digits.";
/** What each effect keeps of a read instead of its content. */
export const PHONE_READ_NOTE =
  "Calendar content is not kept; call phone_calendar_read again to see it.";
export const PHONE_CONTACTS_NOTE =
  "Contacts are not kept; call phone_contacts_search again to see them.";
export const PHONE_LOCATION_NOTE = "The location is not kept; call phone_location again to see it.";
export const PHONE_REMINDERS_NOTE =
  "Reminders are not kept; call phone_reminders_read again to see them.";
/** How many contacts searches one run may make. */
export const PHONE_CONTACTS_SEARCHES_PER_RUN = 3;
/** How many writes to the phone, of either kind, one run may make. */
export const PHONE_WRITES_PER_RUN = 3;
const STALE = "The user's phone gave an old reading. Try again.";

type WithoutRun<T> = T extends unknown ? Omit<T, "botId" | "runId"> : never;

/** One read or write a call asks for, prepared from its arguments. */
interface PhoneReadPlan {
  /** What the phone is sent, besides the bot and the run. */
  request: WithoutRun<
    | PhoneCalendarReadRequest
    | PhoneContactsSearchRequest
    | PhoneLocationRequest
    | PhoneRemindersReadRequest
    | PhoneCalendarCreateRequest
    | PhoneReminderCreateRequest
  >;
  /** Its question is ours alone (the card renders it as Markdown); what the model wrote goes in
   * the detail. */
  card: { text: string; detail?: string; detailFormat?: "code" };
  /** No earlier read stands for the owner's consent: only this call's own card. */
  everyCallAsks?: boolean;
  /**
   * The answer as the model gets it and what the effect keeps instead; why it cannot be used when
   * the phone answered something it should not have; null when it is no answer at all.
   */
  read(
    answer: unknown,
    answeredInMs: number,
  ): { value: unknown; kept: Record<string, unknown> } | { error: string } | null;
}

interface PhoneTool {
  capability: DeviceCapability;
  /** What the model is told when the phone could not do it. */
  cannot: string;
  /**
   * A write: its card shows the whole item, every call asks (consent never carries), and when it
   * may have been written without a readable answer, the model is told so (`unsure`).
   */
  write?: boolean;
  /** The switch in the app's Phone settings. */
  setting: string;
  /** The log line of a read that failed; it carries the failure's kind only. */
  failed: string;
  /** The question of a call whose arguments cannot be read. */
  ask: string;
  plan(args: Record<string, unknown>): PhoneReadPlan | { error: string };
  /** The phone's error codes besides off, permission and unavailable, as the model is told. */
  errors?: Record<string, string>;
  /** How many calls of these kinds one run may make, and what the model is told past it. */
  perRun?: { reads: number; refusal: string; kinds?: readonly string[] };
}

const WRITES_PER_RUN = {
  reads: PHONE_WRITES_PER_RUN,
  refusal: `A run may write to the user's phone at most ${PHONE_WRITES_PER_RUN} times. Ask the user to add the rest.`,
  kinds: PHONE_WRITE_TOOL_NAMES,
};

/** What a write that got no readable answer may have done, as the model is told. */
const unsure = (why: string) =>
  `The user's phone ${why}, so it may have been added. Ask the user before trying again.`;

/** The result a write keeps when it may have been made: the marker the next card looks for. */
const unsureResult = (error: string) => ({ error, uncertain: true });

const PHONE_TOOLS: Record<string, PhoneTool> = {
  [PHONE_CALENDAR_READ_TOOL]: {
    capability: "calendar",
    cannot: "The user's phone could not read its calendar.",
    setting: "Calendar",
    failed: "phone calendar read failed",
    ask: CALENDAR_ASK,
    plan(args) {
      const input = phoneInput(args);
      if ("error" in input) return input;
      const { from, to, query } = input;
      return {
        request: {
          method: "phoneCalendarRead",
          from,
          to,
          ...(query ? { query } : {}),
          limit: PHONE_CALENDAR_MAX_EVENTS,
        },
        card: { text: CALENDAR_ASK, detail: `${from} – ${to}${query ? `\n${query}` : ""}` },
        read(answer) {
          const value = phoneCalendarValue(answer);
          return value && { value, kept: { events: value.events.length, note: PHONE_READ_NOTE } };
        },
      };
    },
  },
  [PHONE_CONTACTS_SEARCH_TOOL]: {
    capability: "contacts",
    cannot: "The user's phone could not read its contacts.",
    setting: "Contacts",
    failed: "phone contacts search failed",
    ask: CONTACTS_ASK,
    perRun: {
      reads: PHONE_CONTACTS_SEARCHES_PER_RUN,
      refusal: `A run may search the user's contacts at most ${PHONE_CONTACTS_SEARCHES_PER_RUN} times. Ask the user instead.`,
    },
    errors: { "contacts-query": CONTACTS_QUERY },
    plan(args) {
      const query = phoneContactsQuery(args.query);
      if (!query) return { error: CONTACTS_QUERY };
      const field = args.field as PhoneContactField;
      if (!PHONE_CONTACT_FIELDS.includes(field))
        return { error: 'field must be "phone" or "email".' };
      return {
        request: { method: "phoneContactsSearch", query, field, limit: PHONE_CONTACTS_MAX },
        card: {
          text: CONTACTS_ASK,
          detail: `${query}\n${field === "phone" ? "Phone numbers" : "Email addresses"}`,
          detailFormat: "code",
        },
        read(answer) {
          const value = phoneContactsValue(answer, field);
          return (
            value && { value, kept: { contacts: value.contacts.length, note: PHONE_CONTACTS_NOTE } }
          );
        },
      };
    },
  },
  [PHONE_LOCATION_TOOL]: {
    capability: "location",
    cannot: "The user's phone could not read its location.",
    setting: "Location",
    failed: "phone location read failed",
    ask: "Let this bot see your phone's location?",
    plan(args) {
      const precision = (args.precision ?? "approximate") as PhoneLocationPrecision;
      if (!PHONE_LOCATION_PRECISIONS.includes(precision))
        return { error: 'precision must be "approximate" or "precise".' };
      return {
        request: { method: "phoneLocation", precision },
        card: { text: `Let this bot see your phone's ${precision} location?` },
        // Where the person is, approximate or precise: the owner allows each reading.
        everyCallAsks: true,
        read(answer, answeredInMs) {
          const value = phoneLocationValue(answer, precision);
          if (!value) return null;
          // Fresh by the server's clock: the phone takes a new fix for each request, so a reading
          // is as old as the wait for it. The phone's own `at` may be off by hours.
          if (answeredInMs > PHONE_ANSWER_MS) return { error: STALE };
          return { value, kept: { read: true, note: PHONE_LOCATION_NOTE } };
        },
      };
    },
  },
  [PHONE_REMINDERS_READ_TOOL]: {
    capability: "reminders",
    cannot: "The user's phone could not read its reminders.",
    setting: "Reminders",
    failed: "phone reminders read failed",
    ask: REMINDERS_ASK,
    plan(args) {
      const input = remindersReadInput(args);
      if ("error" in input) return input;
      const detail = remindersReadDetail(input);
      return {
        request: { method: "phoneRemindersRead", ...input, limit: PHONE_REMINDERS_MAX },
        card: { text: REMINDERS_ASK, ...(detail ? { detail, detailFormat: "code" } : {}) },
        read(answer) {
          const value = phoneRemindersValue(answer);
          return (
            value && {
              value,
              kept: { reminders: value.reminders.length, note: PHONE_REMINDERS_NOTE },
            }
          );
        },
      };
    },
  },
  [PHONE_CALENDAR_CREATE_TOOL]: {
    capability: "calendar-write",
    cannot: "The user's phone could not add the event.",
    write: true,
    setting: "Add to calendar",
    failed: "phone calendar write failed",
    ask: EVENT_ASK,
    perRun: WRITES_PER_RUN,
    errors: {
      "calendar-write-invalid":
        "The user's phone could not add the event as given; check its fields.",
    },
    plan(args) {
      const input = calendarCreateInput(args);
      if ("error" in input) return input;
      return {
        request: { method: "phoneCalendarCreate", event: input.item },
        card: { text: EVENT_ASK, detail: input.lines.join("\n"), detailFormat: "code" },
        everyCallAsks: true,
        read(answer) {
          const value = phoneCalendarCreateValue(answer);
          return value && { value, kept: { created: true } };
        },
      };
    },
  },
  [PHONE_REMINDER_CREATE_TOOL]: {
    capability: "reminders-write",
    cannot: "The user's phone could not add the reminder.",
    write: true,
    setting: "Add reminders",
    failed: "phone reminder write failed",
    ask: REMINDER_ASK,
    perRun: WRITES_PER_RUN,
    errors: {
      "reminders-write-invalid":
        "The user's phone could not add the reminder as given; check its fields.",
      "reminders-write-list":
        "The phone has no reminders list with that name; ask the user which list to use.",
    },
    plan(args) {
      const input = reminderCreateInput(args);
      if ("error" in input) return input;
      return {
        request: { method: "phoneReminderCreate", reminder: input.item },
        card: { text: REMINDER_ASK, detail: input.lines.join("\n"), detailFormat: "code" },
        everyCallAsks: true,
        read(answer) {
          const value = phoneReminderCreateValue(answer);
          return value && { value, kept: { created: true } };
        },
      };
    },
  },
};

/**
 * A call's plan, as its card will show it: a write whose card would not show it whole (it holds
 * one of the bot's secrets, which every card hides) is refused instead, as a lasting write's card
 * is (dozo-lasting-write-card.ts). The limits keep the longest write well within the card's
 * detail (approvalDetailLength), so a secret is the one thing that could cut it.
 */
function planCall(
  tool: PhoneTool,
  args: Record<string, unknown>,
  secrets: readonly string[],
): PhoneReadPlan | { error: string } {
  const plan = tool.plan(args);
  if ("error" in plan || !tool.write) return plan;
  if (containsSecret(plan.request, [...secrets])) return { error: SECRET_ON_CARD };
  return plan;
}

type PhoneDevices = UserDeviceGateway & {
  connectedPhone(userId: string, capability: DeviceCapability): Promise<ConnectedPhone | null>;
};
export type PhoneRoute = ConnectedPhone & { owner: string; devices: PhoneDevices };

function phoneDevices(devices: UserDeviceGateway | undefined): PhoneDevices | undefined {
  return devices && "connectedPhone" in devices ? (devices as PhoneDevices) : undefined;
}

export function isPhoneTool(name: string): boolean {
  return Object.hasOwn(PHONE_TOOLS, name);
}

type ReadBy = {
  spaceId: string;
  groupId?: string | null;
  externalConversationId?: string | null;
  helperBotId?: string | null;
};

/**
 * Whether nobody but the owner can read this thread, where what the phone answers would stay: not
 * a group, a messaging-channel or a helper's thread, in a Space with no other member. A Space's
 * members read every chat of its bots (extra chats included), so a thread is private only there.
 */
export async function onlyOwnerReads(
  prisma: Pick<PrismaClient, "spaceMember">,
  thread: ReadBy,
  owner: string,
): Promise<boolean> {
  if (thread.groupId || thread.externalConversationId || thread.helperBotId) return false;
  const other = await runAsSystem("find another member of a Space", () =>
    prisma.spaceMember.findFirst({
      where: { spaceId: thread.spaceId, userId: { not: owner } },
      select: { id: true },
    }),
  );
  return !other;
}

/** The owner's connected phone with this capability on, for this run; undefined when none. */
export async function phoneRoute(
  ctx: RunContext,
  capability: DeviceCapability,
): Promise<PhoneRoute | undefined> {
  const owner = ctx.source.userComputerOwner;
  const devices = phoneDevices(ctx.deps.userDevices);
  if (!owner || !devices) return undefined;
  if (!(await onlyOwnerReads(ctx.deps.prisma, ctx.thread, owner))) return undefined;
  const phone = await bestEffort(
    "find the user's phone",
    devices.connectedPhone(owner, capability),
  );
  return phone ? { ...phone, owner, devices } : undefined;
}

/**
 * At run assembly: each phone tool leaves the run's turned-off tools (where every run puts it,
 * dozo-no-computer.ts) only when the owner's phone is connected with that capability on, the bot
 * itself did not turn it off, no token's message reached the run, and only the owner reads its
 * thread.
 */
export async function offerPhoneTools(
  deps: { prisma: DozoMarkDb & Pick<PrismaClient, "spaceMember">; userDevices?: UserDeviceGateway },
  run: { botId: string; threadId: string },
  thread: ReadBy,
  owner: string,
  disabled: Set<string>,
  botDisabled: readonly string[] | null | undefined,
): Promise<void> {
  const gateway = phoneDevices(deps.userDevices);
  const kept = PHONE_TOOL_NAMES.filter((name) => !botDisabled?.includes(name));
  if (!gateway || !kept.length) return;
  if (!(await onlyOwnerReads(deps.prisma, thread, owner))) return;
  const reached = await Promise.all(
    kept.map((name) =>
      bestEffort(
        "find the user's phone",
        gateway.connectedPhone(owner, PHONE_TOOLS[name]!.capability),
      ),
    ),
  );
  const offered = kept.filter((_, index) => reached[index]);
  if (offered.length && !(await dozoBotTokenTainted(deps.prisma, run)))
    for (const name of offered) disabled.delete(name);
}

type PhoneInput = { from: string; to: string; query?: string };

/** The range and query of a calendar call, or why they cannot be read. */
export function phoneInput(args: Record<string, unknown>): PhoneInput | { error: string } {
  const from = isoInstant(args.from);
  const to = isoInstant(args.to);
  if (!from || !to)
    return {
      error:
        "from and to must be ISO 8601 times with an offset, such as 2026-03-02T09:00:00+01:00.",
    };
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0) return { error: "to must be after from." };
  if (span > PHONE_CALENDAR_MAX_DAYS * DAY_MS)
    return { error: `The range can be at most ${PHONE_CALENDAR_MAX_DAYS} days; read it in parts.` };
  if (args.query !== undefined && typeof args.query !== "string")
    return { error: "query must be text." };
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length > PHONE_CALENDAR_QUERY_MAX)
    return { error: `query can be at most ${PHONE_CALENDAR_QUERY_MAX} characters.` };
  return { from, to, ...(query ? { query } : {}) };
}

/** Runs whose gate saw a phone call in this process. */
const phoneRuns = new WeakSet<object>();

/** A call's approval as its handler checks it: the phone it saw, consented to. */
const consents = new WeakMap<Record<string, unknown>, { deviceId: string }>();

/** Writes whose card asks after the run read outside content, by their arguments. */
const askedTainted = new WeakSet<Record<string, unknown>>();
/** Writes whose card asks after a write of the run that may have been made, by their arguments. */
const askedUnsure = new WeakSet<Record<string, unknown>>();

/** Whether a write of this run is of unknown outcome: left uncertain, or finished as unsure. */
async function earlierWriteUnsure(ctx: RunContext): Promise<boolean> {
  const found = await ctx.deps.prisma.externalEffect.findFirst({
    where: {
      runId: ctx.runId,
      kind: { in: [...PHONE_WRITE_TOOL_NAMES] },
      OR: [{ status: "uncertain" }, { result: { path: ["uncertain"], equals: true } }],
    },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Whether this run made as many calls of this tool (or its kinds) as one run may. `own` is the
 * effect of the call asking, which is no earlier call.
 */
async function readsInRun(
  ctx: RunContext,
  name: string,
  tool: PhoneTool,
  own?: string,
): Promise<boolean> {
  if (!tool.perRun) return false;
  const { kinds } = tool.perRun;
  const reads = await ctx.deps.prisma.externalEffect.count({
    where: {
      runId: ctx.runId,
      kind: kinds ? { in: [...kinds] } : name,
      ...(own ? { id: { not: own } } : {}),
      // A write still running, or one whose outcome is not known, may have made its item.
      status: { in: tool.write ? ["completed", "executing", "uncertain"] : ["completed"] },
    },
  });
  return reads >= tool.perRun.reads;
}

/**
 * The owner's consent to this call: a completed effect of this tool in a run of this bot and
 * person, made since this kind was last turned on on this pairing, or the card the owner just
 * allowed for this very call (its own arguments: a call beside it rides on no other's card). An
 * effect a crash left executing or uncertain is neither: it may come from a call that never asked.
 * With `cardOnly`, only the card.
 */
function consentTo(
  ctx: RunContext,
  name: string,
  route: PhoneRoute,
  args: Record<string, unknown>,
  cardOnly: boolean,
) {
  return ctx.deps.prisma.externalEffect.findFirst({
    where: {
      spaceId: ctx.run.spaceId,
      kind: name,
      createdAt: { gte: route.onSince },
      run: { userId: route.owner, botId: ctx.bot.id },
      OR: [
        ...(cardOnly ? [] : [{ status: "completed" }]),
        {
          status: "approved",
          runId: ctx.runId,
          request: { equals: args as Prisma.InputJsonValue },
        },
      ],
    },
    select: { id: true, status: true },
  });
}

/**
 * The approval of a phone call, in every approval mode (Never ask included). A block or a run a
 * token's message reached refuses it, as does a run that is not the person's own. A bot reads the
 * phone once its owner allowed this kind of read (`consentTo`); a location read, a write (whose
 * card says so when outside content came first) and any read once outside content entered the
 * run, needs its own card. Otherwise it asks. An allowed read is
 * outside content from that moment, before its answer: calls of one turn decided at the same time
 * get one read on an earlier consent between them, and the others ask. A call that cannot read
 * anything (no phone with that capability, arguments it cannot read, a run past the tool's limit)
 * goes on to its handler, which says why without reading.
 */
export async function phoneGate(
  ctx: RunContext,
  blocked: boolean,
  name: string,
  args: Record<string, unknown>,
): Promise<"deny" | "allow" | "ask"> {
  phoneRuns.add(ctx);
  const tool = PHONE_TOOLS[name]!;
  const owner = ctx.source.userComputerOwner;
  if (blocked || !owner || (await runCameByToken(ctx))) return "deny";
  if (!(await onlyOwnerReads(ctx.deps.prisma, ctx.thread, owner))) return "deny";
  const route = await phoneRoute(ctx, tool.capability);
  const plan = planCall(tool, args, ctx.secrets);
  if (!route || "error" in plan || (await readsInRun(ctx, name, tool))) return "allow";
  const tainted = await isRunTainted(ctx);
  let consent = await consentTo(ctx, name, route, args, Boolean(plan.everyCallAsks) || tainted);
  // Another call of this turn was allowed while this one was looking: only its own card now.
  if (consent?.status === "completed" && ctx.state.tainted)
    consent = await consentTo(ctx, name, route, args, true);
  if (!consent) {
    if (tool.write && tainted) askedTainted.add(args);
    if (tool.write && (await earlierWriteUnsure(ctx))) askedUnsure.add(args);
    return "ask";
  }
  await markReadOutsideContent(ctx);
  consents.set(args, { deviceId: route.deviceId });
  return "allow";
}

/**
 * The card of a phone call: what it reads or writes, and the details of this call; a write's, the
 * whole item, after a fixed line when the run read outside content before it asked.
 */
export function phoneCard(
  effectId: string,
  name: string,
  args: Record<string, unknown>,
  secrets: readonly string[],
): MessageBlock {
  const tool = PHONE_TOOLS[name]!;
  const plan = tool.plan(args);
  const card = "error" in plan ? { text: tool.ask } : plan.card;
  const shown = card.detail ? redactSecrets(card.detail, [...secrets]) : "";
  const lines = [
    ...(askedTainted.has(args) ? [PHONE_WRITE_TAINTED_LINE] : []),
    ...(askedUnsure.has(args) ? [PHONE_WRITE_UNSURE_LINE] : []),
  ];
  const detail = shown ? [...lines, shown].join("\n") : shown;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: card.text,
    ...(detail
      ? { detail, ...(card.detailFormat ? { detailFormat: card.detailFormat } : {}) }
      : {}),
    status: "pending",
    actions: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
  };
}

/**
 * A call that read nothing. One its approval allowed keeps its result; any other is recorded as
 * refused, so it never counts as the owner's consent.
 */
async function refuse(ctx: RunContext, call: ToolCall, error: string, code: string) {
  if (consents.has(call.args)) return call.finish({ error });
  if (call.applied)
    await ctx.deps.prisma.externalEffect.updateMany({
      where: { id: call.applied.effect.id, status: { in: ["intended", "executing"] } },
      data: { status: "denied", result: { refused: code } },
    });
  return { error };
}

/** Why the phone did not read, as the model is told; the kind alone is logged. */
function failure(
  tool: PhoneTool,
  error: unknown,
  deadline: AbortSignal,
): { kind: string; error: string; unsure?: true } {
  if (deadline.aborted)
    return tool.write
      ? { kind: "timeout", error: unsure("did not answer in time"), unsure: true }
      : { kind: "timeout", error: TIMEOUT };
  const text = error instanceof Error ? error.message : "";
  // Another process holding no socket for it says so in words. A write that already went out may
  // have been made before the link dropped: only a call that never left (no route, `phoneRead`) is
  // known to have written nothing.
  if (error instanceof UserDeviceOfflineError || text === USER_DEVICE_OFFLINE_MESSAGE)
    return tool.write
      ? { kind: "offline", error: unsure("lost its connection"), unsure: true }
      : { kind: "offline", error: OFFLINE };
  const { capability, setting, cannot } = tool;
  if (text === `${capability}-off` || text === `${capability}-permission`)
    return {
      kind: text,
      error: `${setting} is off on the user's phone. Ask them to turn on ${setting} in the app's Phone settings.`,
    };
  const extra = tool.errors?.[text];
  if (extra) return { kind: text, error: extra };
  if (text === `${capability}-unavailable`) return { kind: text, error: cannot };
  // An answer of no code the phone knows (a dropped socket included) says nothing of a write.
  return tool.write
    ? { kind: "other", error: unsure("failed in a way that is not known"), unsure: true }
    : { kind: "other", error: cannot };
}

/**
 * Every phone tool: what the call asks for, from the owner's phone, re-checked and cut here. The
 * model gets it; the effect keeps only a count or that it read or wrote, so a replay never shows
 * it.
 */
export async function phoneRead(ctx: RunContext, call: ToolCall) {
  const tool = PHONE_TOOLS[call.name]!;
  if (await runCameByToken(ctx)) return refuse(ctx, call, TOKEN_RUN, "token");
  const plan = planCall(tool, call.args, ctx.secrets);
  if ("error" in plan) return refuse(ctx, call, plan.error, "input");
  if (tool.perRun && (await readsInRun(ctx, call.name, tool, call.applied?.effect.id)))
    return refuse(ctx, call, tool.perRun.refusal, "limit");
  const route = await phoneRoute(ctx, tool.capability);
  if (!route) return refuse(ctx, call, OFFLINE, "offline");
  if (consents.get(call.args)?.deviceId !== route.deviceId)
    return refuse(ctx, call, CHANGED, "changed");
  const { signal } = ctx.context;
  const deadline = deadlineSignal(PHONE_ANSWER_MS, signal);
  const sentAt = Date.now();
  let answer: unknown;
  try {
    for await (const value of route.devices.request<unknown>(
      route.owner,
      { ...plan.request, botId: ctx.bot.id, runId: ctx.runId },
      deadline,
      route.deviceId,
    ))
      answer = value;
  } catch (error) {
    if (signal.aborted) throw error;
    const failed = failure(tool, error, deadline);
    getLogger().warn(tool.failed, { kind: failed.kind });
    return call.finish(failed.unsure ? unsureResult(failed.error) : { error: failed.error });
  }
  const read = plan.read(answer, Date.now() - sentAt);
  if (!read) {
    getLogger().warn(tool.failed, { kind: "invalid" });
    return call.finish(
      tool.write
        ? unsureResult(unsure("gave an answer that cannot be read"))
        : { error: tool.cannot },
    );
  }
  if ("error" in read) {
    getLogger().warn(tool.failed, { kind: "stale" });
    return call.finish({ error: read.error });
  }
  if (!(await call.persistEffectResult(read.kept)))
    return uncertainEffectResult(call.name, call.args);
  return read.value;
}

/**
 * Whether this run read the phone (or asked to): its turn is then not kept in conversation memory.
 * Known in this process once the run's gate saw a phone call; an earlier attempt's call is looked
 * up only for a run that could reach a phone at all, so no other run does any work for it.
 */
export async function runReadPhone(
  ctx: Pick<RunContext, "deps" | "runId" | "source">,
): Promise<boolean> {
  if (phoneRuns.has(ctx)) return true;
  if (!ctx.source.userComputerOwner || !phoneDevices(ctx.deps.userDevices)) return false;
  const effect = await ctx.deps.prisma.externalEffect.findFirst({
    where: { runId: ctx.runId, kind: { in: [...PHONE_TOOL_NAMES] } },
    select: { id: true },
  });
  return effect !== null;
}
