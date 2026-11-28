import type { MessageBlock, ToolHistory } from "@rakazo/contracts";
import { DOZO_REPLAY_STEPS_MAX, ToolHistorySchema } from "@rakazo/contracts";

/** One step of a reply as a replay can show it. Nothing here is the call's input or output. */
export type ReplayStep = {
  /** The kind of action, as the chat shows the step, and the site it acted on by host name. */
  line: string;
  /** The screenshot the reply kept for one of the step's calls. */
  frameArtifactId?: string;
  /** This step touched a sign-in, a saved value, a payment or a site the bot is signed in to. */
  sensitive: boolean;
};

const LABEL_MAX = 80;
const SENSITIVE_NAME =
  /secret|password|passkey|credential|log_?in|sign_?in|auth|otp|2fa|vault|payment|checkout|billing|card|wallet|purchase/i;
/** Browser actions that type a saved login, a code, a card or a pay token. */
const SENSITIVE_ARGUMENT =
  /fill_secret|fill_card|fill_code|fill_pay_token|purchaseId|savedCard|"secret"|"cardId"/i;
const SENSITIVE_ADDRESS =
  /log-?in|sign-?in|sign-?up|auth|sso|password|account|checkout|payment|billing|wallet|cart|\bpay\b/i;
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

/** Every http(s) address in a call's arguments, at any depth up to a few levels. */
function addressesIn(value: unknown, depth = 0): URL[] {
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) && URL.canParse(value) ? [new URL(value)] : [];
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap((child) => addressesIn(child, depth + 1));
}

function parsedArguments(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function onSite(host: string, sites: readonly string[]): boolean {
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/**
 * The steps of a bot reply, in the order the chat shows them, as lines a stranger may read: what
 * kind of action, and on which site by host name. The label is the step's own, which the chat
 * already shows; the host is read from the call's address and nothing else of it is kept.
 * `signedInSites` are the registrable domains the bot's browser holds a session for.
 */
export function replaySteps(
  blocks: readonly MessageBlock[],
  history: ToolHistory | undefined,
  signedInSites: readonly string[] = [],
): ReplayStep[] {
  const shown = blocks.flatMap((block) => (block.kind === "steps" ? block.steps : []));
  return shown.slice(0, DOZO_REPLAY_STEPS_MAX).map((step, index) => {
    const kept = history?.steps[index] ?? null;
    const label = step.label.trim().slice(0, LABEL_MAX);
    const calls = kept?.calls ?? [];
    const addresses = calls.flatMap((call) => addressesIn(parsedArguments(call.arguments)));
    const host = addresses[0]?.hostname.toLowerCase();
    const frameArtifactId = calls.findLast((call) => call.image)?.image?.artifactId;
    const sensitive =
      SENSITIVE_NAME.test(kept?.tool ?? label) ||
      calls.some((call) => SENSITIVE_ARGUMENT.test(call.arguments ?? "")) ||
      addresses.some(
        (url) =>
          SENSITIVE_ADDRESS.test(`${url.hostname}${url.pathname}`) ||
          onSite(url.hostname.toLowerCase(), signedInSites),
      );
    return {
      line: host ? `${label} · ${host}` : label,
      ...(frameArtifactId ? { frameArtifactId } : {}),
      sensitive,
    };
  });
}

/**
 * Whether each step's screenshot starts left out: a step that touched a sign-in, a saved value, a
 * payment or a signed-in site, and every step after it, since the session it opened stays open.
 */
export function framesLeftOut(steps: readonly ReplayStep[]): boolean[] {
  let touched = false;
  return steps.map((step) => {
    touched ||= step.sensitive;
    return touched;
  });
}
