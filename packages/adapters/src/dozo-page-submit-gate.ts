import type { DomNode } from "./dozo-page-submit.js";
import { notedPageSubmits, sendingSteps, submitsIn } from "./dozo-page-submit.js";
import type { Route } from "./dozo-user-browser-gate.js";
import { userBrowserRoute } from "./dozo-user-browser-gate.js";
import type { RunContext } from "./run-context.js";

/** The desktop passes only a whole number as a depth, so "all of it" is a number no page reaches. */
const DOM_DEPTH = 256;

/** The DOM of the page in the user's own browser, or nothing when it cannot be read. */
async function deviceDocument(ctx: RunContext, route: Route): Promise<DomNode | undefined> {
  const request = route.devices.request<{ result?: { root?: DomNode } }>(
    route.owner,
    {
      method: "pageBrowser",
      botId: ctx.bot.id,
      botName: ctx.bot.name,
      runId: ctx.runId,
      command: { method: "DOM.getDocument", params: { depth: DOM_DEPTH } },
    },
    ctx.context.signal,
    route.deviceId,
  );
  let answer: { result?: { root?: DomNode } } | undefined;
  try {
    for await (const value of request) answer = value;
  } catch {
    ctx.context.signal.throwIfAborted();
    return undefined;
  }
  const root = answer?.result?.root;
  return root && typeof root === "object" ? root : undefined;
}

/**
 * How many form submits a page tool call would make, judged before it runs: in the user's own browser from
 * its page's DOM, on the bot's computer from what that computer's page browser reported for the same
 * clicks. Nothing else counts.
 */
export async function dozoPageSubmits(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
): Promise<number> {
  if (name !== "browser_act" || !Array.isArray(args.actions)) return 0;
  if (ctx.source?.userComputerOwner) {
    const route = await userBrowserRoute(ctx);
    if (route) {
      const steps = sendingSteps(args.actions);
      return steps.length ? submitsIn(await deviceDocument(ctx, route), steps) : 0;
    }
  }
  return notedPageSubmits(args.actions) ?? 0;
}
