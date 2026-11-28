import { createHash } from "node:crypto";
import type { MessageBlock, ToolHistory } from "@rakazo/contracts";
import {
  BUILTIN_TOOL_NAMES,
  DOZO_REPLAY_STEPS_MAX,
  FLEET_TOOL_NAMES,
  ToolHistorySchema,
} from "@rakazo/contracts";
import { humanizeToolName } from "@rakazo/core";

/** One step of a reply as a replay can show it. Nothing here is the call's input or output. */
export type ReplayStep = {
  /** The kind of action and, for a page the bot opened, its site by public host name. */
  line: string;
  /** The screenshot the reply kept for one of the step's calls. */
  frameArtifactId?: string;
  /**
   * This step touched a sign-in, a saved value, a payment, typed text or a signed-in site, or is a
   * browser step while the signed-in sites are unknown.
   */
  sensitive: boolean;
  /** The step's calls were kept, so what it did could be read at all. */
  classified: boolean;
  /** The step's label as the chat stores it; only fingerprinted, never shown. */
  stored: string;
};

/** The contract's limit on a line (`DozoReplayPayloadSchema`). */
const LINE_MAX = 200;
const LABEL_MAX = 80;
const SEPARATOR = " · ";
/** What a step of a tool that is not built in shows: its name is the person's own. */
const GENERIC_LABEL = "Action";
const BUILT_IN = new Set<string>([...BUILTIN_TOOL_NAMES, ...FLEET_TOOL_NAMES]);
const BUILT_IN_LABELS = new Map([...BUILT_IN].map((name) => [humanizeToolName(name), name]));
/** Tools whose `url` argument is the page they open: the only place a host is read from. */
const NAVIGATION_TOOLS = new Set(["browser_navigate"]);
const BROWSER_TOOL = /^(browser|computer|user_computer)_/;
const SENSITIVE_NAME =
  /secret|password|passkey|credential|log_?in|sign_?in|auth|otp|2fa|vault|payment|checkout|billing|card|wallet|purchase/i;
/** Browser actions that type a saved login, a code, a card or a pay token. */
const SENSITIVE_ARGUMENT =
  /fill_secret|fill_card|fill_code|fill_pay_token|purchaseId|savedCard|"secret"|"cardId"/i;
const SENSITIVE_ADDRESS =
  /log-?in|sign-?in|sign-?up|auth|sso|password|account|checkout|payment|billing|wallet|cart|\bpay\b/i;
/** An action that types into the page or the desktop. */
const TYPING_KIND = /^(type|key|fill(_\w+)?)$/;
/** Names that only resolve inside a network or are reserved, never a public site. */
const PRIVATE_SUFFIX =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|example|invalid|onion|arpa)$/;
const MAX_DEPTH = 4;

/** A message's stored tool history, or none when it has none or it cannot be read. */
export function parseToolHistory(stored: string | null | undefined): ToolHistory | undefined {
  if (!stored) return undefined;
  try {
    const parsed = ToolHistorySchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parsedArguments(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Whether the arguments hold an action that types, at any depth up to a few levels. */
function types(value: unknown, depth = 0): boolean {
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return false;
  const fields = value as Record<string, unknown>;
  const kind = fields.kind ?? fields.action;
  if (typeof kind === "string" && TYPING_KIND.test(kind)) return true;
  if (typeof fields.text === "string" && fields.text.length > 0) return true;
  return Object.values(fields).some((child) => types(child, depth + 1));
}

/** The address a navigation call opened, or none. */
function openedAddress(tool: string | undefined, args: unknown): URL | undefined {
  if (!tool || !NAVIGATION_TOOLS.has(tool) || args === null || typeof args !== "object") return;
  const url = (args as { url?: unknown }).url;
  if (typeof url !== "string" || !URL.canParse(url)) return;
  const parsed = new URL(url);
  return /^https?:$/.test(parsed.protocol) ? parsed : undefined;
}

/**
 * The host a stranger may read, or none: never an address literal, a name without a dot, or a
 * private or reserved name. A name in another script stays in its `xn--` form, which cannot pass
 * for another site's.
 */
export function publicHost(url: URL, room: number): string | undefined {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host.startsWith("[") ||
    /^[\d.]+$/.test(host) ||
    !host.includes(".") ||
    PRIVATE_SUFFIX.test(host) ||
    host.length > room
  )
    return undefined;
  return host;
}

function onSite(host: string, sites: readonly string[]): boolean {
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/** A built-in tool's own label; any other tool's name is the person's, so it shows generically. */
function labelOf(tool: string | undefined, shown: string): string {
  if (tool) return BUILT_IN.has(tool) ? humanizeToolName(tool) : GENERIC_LABEL;
  return BUILT_IN_LABELS.has(shown.trim()) ? shown.trim() : GENERIC_LABEL;
}

/**
 * The steps of a bot reply, in the order the chat shows them, as lines a stranger may read: what
 * kind of action, and for a page the bot opened, its public host. `signedInSites` are the
 * registrable domains the bot's browser holds a session for, or null when they cannot be read,
 * which makes every browser step sensitive.
 */
export function replaySteps(
  blocks: readonly MessageBlock[],
  history: ToolHistory | undefined,
  signedInSites: readonly string[] | null = [],
): ReplayStep[] {
  const shown = blocks.flatMap((block) => (block.kind === "steps" ? block.steps : []));
  return shown.slice(0, DOZO_REPLAY_STEPS_MAX).map((step, index) => {
    const kept = history?.steps[index] ?? null;
    const tool = kept?.tool;
    const label = labelOf(tool, step.label).slice(0, LABEL_MAX);
    const calls = kept?.calls ?? [];
    const args = calls.map((call) => parsedArguments(call.arguments));
    const addresses = args.flatMap((value) => openedAddress(tool, value) ?? []);
    const host =
      addresses[0] && publicHost(addresses[0], LINE_MAX - label.length - SEPARATOR.length);
    const frameArtifactId = calls.findLast((call) => call.image)?.image?.artifactId;
    const browser = BROWSER_TOOL.test(tool ?? BUILT_IN_LABELS.get(step.label.trim()) ?? "");
    const sensitive =
      SENSITIVE_NAME.test(tool ?? "") ||
      SENSITIVE_NAME.test(step.label) ||
      calls.some((call) => SENSITIVE_ARGUMENT.test(call.arguments ?? "")) ||
      args.some((value) => types(value)) ||
      (browser && signedInSites === null) ||
      addresses.some(
        (url) =>
          SENSITIVE_ADDRESS.test(`${url.hostname}${url.pathname}${url.search}${url.hash}`) ||
          onSite(url.hostname.toLowerCase(), signedInSites ?? []),
      );
    return {
      line: host ? `${label}${SEPARATOR}${host}` : label,
      ...(frameArtifactId ? { frameArtifactId } : {}),
      sensitive,
      classified: kept !== null,
      stored: step.label,
    };
  });
}

/**
 * Whether the reply's screenshots start left out: a screenshot is the screen after the whole
 * reply, so any step that was sensitive, or whose calls were not kept, leaves out every one.
 */
export function framesStartLeftOut(steps: readonly ReplayStep[]): boolean {
  return steps.some((step) => step.sensitive || !step.classified);
}

/**
 * What the owner reviewed: the published lines in order, the stored labels they came from, and the
 * screenshots they chose. A reply rewritten since then no longer matches, so its link shows nothing.
 */
export function replayFingerprint(
  published: ReadonlyArray<{ line: string; stored: string; frameArtifactId?: string }>,
): string {
  const reviewed = published.map((step) => [step.line, step.stored, step.frameArtifactId ?? null]);
  return createHash("sha256").update(JSON.stringify(reviewed)).digest("hex");
}
