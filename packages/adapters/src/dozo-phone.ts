import type { MessageBlock } from "@rakazo/contracts";
import { deadlineSignal, redactSecrets } from "@rakazo/core";
import { bestEffort, getLogger } from "@rakazo/logging";
import { uncertainEffectResult } from "./approval-effect.js";
import type { DeviceCapability } from "./dozo-device-capabilities.js";
import { PHONE_CALENDAR_READ_TOOL } from "./dozo-phone.tool-definition.js";
import {
  PHONE_CALENDAR_MAX_DAYS,
  PHONE_CALENDAR_MAX_EVENTS,
  PHONE_CALENDAR_QUERY_MAX,
  phoneCalendarValue,
} from "./dozo-phone-protocol.js";
import type { DozoMarkDb } from "./dozo-token-marks.js";
import { dozoBotTokenTainted, runCameByToken } from "./dozo-token-run.js";
import type { ConnectedPhone } from "./dozo-user-device-gateway.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { USER_DEVICE_OFFLINE_MESSAGE, UserDeviceOfflineError } from "./user-device-gateway.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

/**
 * The calendar on the user's own phone (phone_calendar_read). The phone pairs and connects as a
 * user device (dozo-user-device-gateway.ts) and declares `calendar` only while its switch is on
 * and the system allows it. Only the person's own chat runs reach it (`userComputerOwner`), never
 * a run a token's message reached. A bot's first read on that pairing asks, in every approval
 * mode; its effect keeps a count, never the events, and the turn is kept out of memory.
 */

/** How long the phone has to answer: the device default (ten minutes) is far too long here. */
export const PHONE_ANSWER_MS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const OFFLINE =
  "The user's phone is not connected. Ask them to open the app on their phone, then try again.";
const TURN_ON =
  "Calendar is off on the user's phone. Ask them to turn on Calendar in the app's Phone settings.";
const UNREADABLE = "The user's phone could not read its calendar.";
const TIMEOUT = "The user's phone did not answer in time. Ask them to keep the app open.";
const CHANGED = "The user's phone changed since this was approved. Try again.";
const TOKEN_RUN = "The user's phone is not used for a message sent with a token.";
/** What the effect keeps of a read instead of its events. */
export const PHONE_READ_NOTE =
  "Calendar content is not kept; call phone_calendar_read again to see it.";

type PhoneDevices = UserDeviceGateway & {
  connectedPhone(userId: string, capability: DeviceCapability): Promise<ConnectedPhone | null>;
};
export type PhoneRoute = ConnectedPhone & { owner: string; devices: PhoneDevices };

function phoneDevices(devices: UserDeviceGateway | undefined): PhoneDevices | undefined {
  return devices && "connectedPhone" in devices ? (devices as PhoneDevices) : undefined;
}

export function isPhoneTool(name: string): boolean {
  return name === PHONE_CALENDAR_READ_TOOL;
}

/** The owner's connected phone with its calendar on, for this run; undefined when there is none. */
export async function phoneRoute(ctx: RunContext): Promise<PhoneRoute | undefined> {
  const owner = ctx.source.userComputerOwner;
  const devices = phoneDevices(ctx.deps.userDevices);
  if (!owner || !devices) return undefined;
  const phone = await bestEffort(
    "find the user's phone",
    devices.connectedPhone(owner, "calendar"),
  );
  return phone ? { ...phone, owner, devices } : undefined;
}

/**
 * At run assembly: the phone tool leaves the run's turned-off tools (where every run puts it,
 * dozo-no-computer.ts) only when the owner's phone is connected with its calendar on, the bot
 * itself did not turn it off, and no token's message reached the run.
 */
export async function offerPhoneTools(
  deps: { prisma: DozoMarkDb; userDevices?: UserDeviceGateway },
  run: { botId: string; threadId: string },
  owner: string,
  disabled: Set<string>,
  botDisabled: readonly string[] | null | undefined,
): Promise<void> {
  const gateway = phoneDevices(deps.userDevices);
  if (!gateway || botDisabled?.includes(PHONE_CALENDAR_READ_TOOL)) return;
  const phone = await bestEffort(
    "find the user's phone",
    gateway.connectedPhone(owner, "calendar"),
  );
  if (phone && !(await dozoBotTokenTainted(deps.prisma, run)))
    disabled.delete(PHONE_CALENDAR_READ_TOOL);
}

type PhoneInput = { from: string; to: string; query?: string };
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;

function instant(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return ISO_WITH_OFFSET.test(text) && !Number.isNaN(Date.parse(text)) ? text : undefined;
}

/** The range and query of a call, or why they cannot be read. */
export function phoneInput(args: Record<string, unknown>): PhoneInput | { error: string } {
  const from = instant(args.from);
  const to = instant(args.to);
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

/** A call's approval as its handler checks it: the phone it saw, consented to. */
const consents = new WeakMap<Record<string, unknown>, { deviceId: string }>();

/**
 * The approval of a phone read, in every approval mode (Never ask included). A block or a run a
 * token's message reached refuses it, as does a run that is not the person's own. A bot reads the
 * phone once its owner allowed it on this pairing: a completed effect of this tool in a run of this
 * bot and person, made since the phone was paired, or this run's own card the owner allowed.
 * Otherwise it asks. A call that
 * cannot read anything (no phone connected, a range it cannot read) goes on to its handler, which
 * says why without reading.
 */
export async function phoneGate(
  ctx: RunContext,
  blocked: boolean,
  args: Record<string, unknown>,
): Promise<"deny" | "allow" | "ask"> {
  if (blocked || !ctx.source.userComputerOwner || (await runCameByToken(ctx))) return "deny";
  const route = await phoneRoute(ctx);
  if (!route || "error" in phoneInput(args)) return "allow";
  const consent = await ctx.deps.prisma.externalEffect.findFirst({
    where: {
      spaceId: ctx.run.spaceId,
      kind: PHONE_CALENDAR_READ_TOOL,
      createdAt: { gte: route.pairedAt },
      run: { userId: route.owner, botId: ctx.bot.id },
      // A read that finished, or the card the owner just allowed for this call. An effect a
      // crash left executing or uncertain is neither: it may come from a call that never asked.
      OR: [{ status: "completed" }, { status: "approved", runId: ctx.runId }],
    },
    select: { id: true },
  });
  if (!consent) return "ask";
  consents.set(args, { deviceId: route.deviceId });
  return "allow";
}

/** The card of a phone read: what it reads, and the range it reads. */
export function phoneCard(
  effectId: string,
  args: Record<string, unknown>,
  secrets: readonly string[],
): MessageBlock {
  const input = phoneInput(args);
  const range =
    "error" in input ? "" : `${input.from} – ${input.to}${input.query ? `\n${input.query}` : ""}`;
  const detail = redactSecrets(range, [...secrets]);
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: "Let this bot read your phone's calendar?",
    ...(detail ? { detail } : {}),
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
function failure(error: unknown, deadline: AbortSignal): { kind: string; error: string } {
  if (deadline.aborted) return { kind: "timeout", error: TIMEOUT };
  const text = error instanceof Error ? error.message : "";
  // Another process holding no socket for it says so in words.
  if (error instanceof UserDeviceOfflineError || text === USER_DEVICE_OFFLINE_MESSAGE)
    return { kind: "offline", error: OFFLINE };
  if (text === "calendar-off" || text === "calendar-permission")
    return { kind: text, error: TURN_ON };
  return { kind: text === "calendar-unavailable" ? text : "other", error: UNREADABLE };
}

/**
 * phone_calendar_read: the events in a range, from the owner's phone, re-checked and cut here.
 * The model gets them; the effect keeps only how many there were, so a replay never shows them.
 */
export async function phoneCalendarRead(ctx: RunContext, call: ToolCall) {
  if (await runCameByToken(ctx)) return refuse(ctx, call, TOKEN_RUN, "token");
  const input = phoneInput(call.args);
  if ("error" in input) return refuse(ctx, call, input.error, "input");
  const route = await phoneRoute(ctx);
  if (!route) return refuse(ctx, call, OFFLINE, "offline");
  if (consents.get(call.args)?.deviceId !== route.deviceId)
    return refuse(ctx, call, CHANGED, "changed");
  const { signal } = ctx.context;
  const deadline = deadlineSignal(PHONE_ANSWER_MS, signal);
  let answer: unknown;
  try {
    for await (const value of route.devices.request<unknown>(
      route.owner,
      {
        method: "phoneCalendarRead",
        botId: ctx.bot.id,
        runId: ctx.runId,
        from: input.from,
        to: input.to,
        ...(input.query ? { query: input.query } : {}),
        limit: PHONE_CALENDAR_MAX_EVENTS,
      },
      deadline,
      route.deviceId,
    ))
      answer = value;
  } catch (error) {
    if (signal.aborted) throw error;
    const failed = failure(error, deadline);
    getLogger().warn("phone calendar read failed", { kind: failed.kind });
    return call.finish({ error: failed.error });
  }
  const read = phoneCalendarValue(answer);
  if (!read) {
    getLogger().warn("phone calendar read failed", { kind: "invalid" });
    return call.finish({ error: UNREADABLE });
  }
  const kept = { events: read.events.length, note: PHONE_READ_NOTE };
  if (!(await call.persistEffectResult(kept))) return uncertainEffectResult(call.name, call.args);
  return read;
}

/** Whether this run read the phone: its turn is then not kept in conversation memory. */
export async function runReadPhone(ctx: Pick<RunContext, "deps" | "runId">): Promise<boolean> {
  const effect = await ctx.deps.prisma.externalEffect.findFirst({
    where: { runId: ctx.runId, kind: PHONE_CALENDAR_READ_TOOL },
    select: { id: true },
  });
  return effect !== null;
}
