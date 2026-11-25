import { refNode } from "./dozo-device-browser.js";
import type { DomNode, Step } from "./dozo-page-submit.js";
import { couldSubmit, notedPageSubmits, sendingSteps, submitsIn } from "./dozo-page-submit.js";
import type { Route } from "./dozo-user-browser-gate.js";
import { userBrowserRoute } from "./dozo-user-browser-gate.js";
import type { RunContext } from "./runs/assembly/run-context.js";

/** The desktop passes only a whole number as a depth, so "all of it" is a number no page reaches. */
const DOM_DEPTH = 256;

/** What one command of the user's own browser answers, or nothing when it fails. */
async function deviceCommand<T>(
  ctx: RunContext,
  route: Route,
  command: { method: string; params: Record<string, unknown> },
): Promise<T | undefined> {
  const request = route.devices.request<{ result?: T }>(
    route.owner,
    {
      method: "pageBrowser",
      botId: ctx.bot.id,
      botName: ctx.bot.name,
      runId: ctx.runId,
      command,
    },
    ctx.context.signal,
    route.deviceId,
  );
  let answer: { result?: T } | undefined;
  try {
    for await (const value of request) answer = value;
  } catch {
    ctx.context.signal.throwIfAborted();
    return undefined;
  }
  return answer?.result;
}

/**
 * How many of these steps submit a form in the user's own browser. Each element is read alone first (its tag
 * and attributes), which settles every press that cannot submit; the page's DOM is read, once, only when a
 * press could. What is read is judged here and kept nowhere: only the count leaves this function.
 */
async function deviceSubmits(ctx: RunContext, route: Route, steps: Step[]): Promise<number> {
  let unknown = 0;
  const possible: Step[] = [];
  for (const step of steps) {
    const backendNodeId = refNode(step.ref);
    const described =
      backendNodeId === undefined
        ? undefined
        : await deviceCommand<{ node?: DomNode }>(ctx, route, {
            method: "DOM.describeNode",
            params: { backendNodeId },
          });
    if (!described?.node) unknown += 1;
    else if (couldSubmit(described.node, step)) possible.push(step);
  }
  if (!possible.length) return unknown;
  const document = await deviceCommand<{ root?: DomNode }>(ctx, route, {
    method: "DOM.getDocument",
    params: { depth: DOM_DEPTH },
  });
  const root = document?.root;
  return unknown + submitsIn(root && typeof root === "object" ? root : undefined, possible);
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
      return steps.length ? deviceSubmits(ctx, route, steps) : 0;
    }
  }
  return notedPageSubmits(args.actions) ?? 0;
}
