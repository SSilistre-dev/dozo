import {
  buildSkillMd,
  ClientError,
  humanizeToolName,
  instructionUpdateDiff,
  lastingWriteNeedsApproval,
  lastingWriteShowsWholeText,
  parseSkillMd,
  redactSecrets,
} from "@rakazo/core";
import type { FleetCardSummary } from "./approval-ask.js";
import { approvalDetailLength } from "./approval-ask.js";
import { runReadOutsideContent } from "./dozo-read-outside.js";
import { runCameByToken } from "./dozo-token-run.js";
import { routineTaskInstructions } from "./routine-watch.js";
import type { RunContext } from "./run-context.js";
import type { ToolRequest } from "./run-tool-request.js";
import { skillReadFromTool } from "./skill-tools.js";
import { refusal } from "./tool-refusal.js";

/**
 * Whether the gate holds this call as a lasting write (lastingWriteNeedsApproval): the run's input
 * came from outside the owner, a token's text reached its bot, or it read outside content. A
 * subagent's call is the run's own, so it is judged by the run.
 */
export function lastingWriteHeld(ctx: RunContext, name: string): Promise<boolean> {
  const { run, source, task } = ctx;
  const started = {
    trigger: run.trigger,
    ownerStartedRun: source.ownerStartedRun,
    nonOwnerChatRun: source.messagingChannelRun,
    watchFired: run.trigger === "routine" && routineTaskInstructions(task.prompt) !== task.prompt,
  };
  return lastingWriteNeedsApproval(
    name,
    started,
    async () => (await runCameByToken(ctx)) || (await runReadOutsideContent(ctx)),
  );
}

/** The text keys whose whole value the card ends with, after the short ones. */
const LONG_TEXT_KEYS = ["description", "body", "content", "prompt"];

/**
 * The card for a lasting write lastingWriteHeld held: it shows the whole text that will be saved,
 * after redaction, and a skill update as a diff of the current skill when that fits. One that cannot be shown whole is refused instead, so a person never approves text
 * the card cut off. Nothing is built for a write the lasting-write rule did not hold, or for the
 * approved replay, which shows no card.
 */
export async function lastingWriteCard(
  ctx: RunContext,
  request: ToolRequest,
  held: boolean,
): Promise<{ summary?: FleetCardSummary; error?: { error: string } }> {
  const { name, args } = request;
  if (!held || !lastingWriteShowsWholeText(name) || request.nextApprovedTool === name) return {};
  // Every line is already redacted, so its length is the length the card shows.
  const fits = (lines: string[]) => lines.join("\n").length <= approvalDetailLength(name);
  const { short, long } = argumentLines(args, ctx.secrets);
  const diff = name === "skill_update" ? await skillUpdateDiff(ctx, args) : undefined;
  const lines = diff && fits([...short, diff]) ? [...short, diff] : [...short, ...long];
  if (!fits(lines)) {
    return {
      error: refusal(
        "approval_card_too_long",
        "This is too long to show on the approval card; shorten it.",
      ),
    };
  }
  // The generic card's title, with the tool's name in words.
  const title = `Review before ${humanizeToolName(name).toLowerCase()}`;
  return { summary: { title, lines, onceOnly: true } };
}

/** Every argument in full as `key: value`, short values first and long text last. */
function argumentLines(
  args: Record<string, unknown>,
  secrets: string[],
): { short: string[]; long: string[] } {
  const line = (key: string) => {
    const value = redactLeaves(args[key], secrets);
    if (value == null || value === "") return [];
    return [`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`];
  };
  return {
    short: Object.keys(args)
      .filter((key) => !LONG_TEXT_KEYS.includes(key))
      .flatMap(line),
    long: LONG_TEXT_KEYS.filter((key) => key in args).flatMap(line),
  };
}

/** Redacts every string inside a value, since JSON escaping could hide a secret from the card. */
function redactLeaves(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactLeaves(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactLeaves(item, secrets)]),
    );
  return value;
}

/**
 * The current skill against what skill_update would save, as the instruction card shows a change.
 * Undefined when the skill cannot be read or the update would fail; the card then shows the
 * arguments in full.
 */
async function skillUpdateDiff(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
  const current = await skillReadFromTool(
    ctx.deps.prisma,
    { spaceId: ctx.run.spaceId, userId: ctx.run.userId },
    { name: text("name"), skillId: text("skillId") },
  );
  const { name, description, content } = current;
  if (typeof content !== "string" || typeof name !== "string" || typeof description !== "string")
    return undefined;
  const next = nextSkillContent({ name, description, content }, text);
  if (next === undefined) return undefined;
  return instructionUpdateDiff(
    redactSecrets(content, ctx.secrets),
    redactSecrets(next, ctx.secrets),
  );
}

/** What skillUpdateFromTool would store, or undefined where it would refuse. */
function nextSkillContent(
  current: { name: string; description: string; content: string },
  text: (key: string) => string | undefined,
): string | undefined {
  try {
    const replacement = text("content");
    if (replacement?.trim()) {
      const parsed = parseSkillMd(replacement);
      return "error" in parsed ? undefined : buildSkillMd(parsed);
    }
    const prior = parseSkillMd(current.content);
    if ("error" in prior) return undefined;
    return buildSkillMd({
      name: text("newName")?.trim() || current.name,
      description: text("description")?.trim() ?? current.description,
      body: text("body") ?? prior.body,
      frontmatter: prior.frontmatter,
    });
  } catch (error) {
    // buildSkillMd refuses fields the tool would refuse too.
    if (error instanceof ClientError) return undefined;
    throw error;
  }
}
