import type { AgentToolExecutionResult, ComputerRef } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { JsonColumnMismatchError, readJsonColumn } from "@rakazo/db";
import { z } from "zod";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserResultForModel,
  browserSnapshotFromTool,
  redactBrowserResult,
} from "./browser-tools.js";
import type { DeviceBrowserEvent } from "./dozo-device-browser.js";
import { DeviceBrowserProvider } from "./dozo-device-browser.js";
import { filesWithoutComputer } from "./dozo-no-computer.js";
import { runCameByToken } from "./dozo-token-run.js";
import type { Route } from "./dozo-user-browser-gate.js";
import {
  APPROVED_SITE,
  pageSite,
  recordConsent,
  userBrowserAsk,
  userBrowserRoute,
} from "./dozo-user-browser-gate.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { pageBrowserTool as computerPageBrowserTool } from "./run-tools-computer.js";

/**
 * The page tools (`browser_navigate`, `browser_snapshot`, `browser_act`) on the user's own
 * computer: when the person who started the run has their desktop app connected and it declared
 * a browser, these tools drive a browser of the bot's own there (dozo-device-browser.ts), the same
 * tools with the same results as on the bot's computer. Only in the person's own chat runs
 * (`userComputerOwner`), never in a run a token's message reached. The first use by a bot on a
 * computer asks, and so does its first action on each site; a later sign-in flow builds on that.
 */
export const USER_BROWSER_NOTE =
  "This browser is your own, on the user's computer, in a window they can see. If a site needs signing in, ask the user to sign in there themselves, then continue.";
const UNAVAILABLE =
  "The user's computer is not connected, so its browser cannot be used now. Ask them to open the desktop app if the task needs it.";
const CHANGED =
  "The browser on the user's computer was not part of this call's approval. Try again.";
const MOVED = "The browser shows another site than the one the user approved. Ask again.";
const TOKEN_RUN = "The browser on the user's computer is not used for a message sent with a token.";

const providers = new WeakMap<RunContext, DeviceBrowserProvider>();

async function lastValue<T>(values: AsyncIterable<T>): Promise<T> {
  let result: { value: T } | undefined;
  for await (const value of values) result = { value };
  if (!result) throw new Error("no response");
  return result.value;
}

/** The run's browser on that computer, one per run so it keeps what the page said. */
function providerFor(ctx: RunContext, route: Route): DeviceBrowserProvider {
  const known = providers.get(ctx);
  if (known) return known;
  const provider = new DeviceBrowserProvider((command) =>
    lastValue(
      route.devices.request<{ result?: unknown; events?: DeviceBrowserEvent[] }>(
        route.owner,
        { method: "pageBrowser", botId: ctx.bot.id, runId: ctx.runId, command },
        ctx.context.signal,
        route.deviceId,
      ),
    ),
  );
  providers.set(ctx, provider);
  return provider;
}

/**
 * The page tools' handler: the user's own browser when the run reaches one, otherwise the bot's
 * computer as upstream has it. A run without a computer of its own whose user's computer went away
 * says so instead of starting a computer it does not have.
 */
export async function pageBrowserTool(ctx: RunContext, call: ToolCall) {
  const route = await userBrowserRoute(ctx);
  if (route) return userBrowserTool(ctx, call, route);
  if (ctx.source.userComputerOwner && filesWithoutComputer(ctx.computer.stored))
    return call.finish({ error: UNAVAILABLE });
  return computerPageBrowserTool(ctx, call);
}

/**
 * Why a call to the user's browser may not run, after it records what its approval allowed; or
 * nothing. Only a call this browser's approval saw runs: one that reached the user's computer
 * after its approval went the other way is refused, not run without a card. A call that asked
 * runs only on the site its card named (kept with its effect), and only on that computer.
 */
async function refusal(ctx: RunContext, call: ToolCall, route: Route) {
  if (await runCameByToken(ctx)) return call.finish({ error: TOKEN_RUN });
  const asked = userBrowserAsk(call.args);
  if (!asked) return call.finish({ error: CHANGED });
  if (asked.deviceId !== route.deviceId)
    return call.finish({
      error: "The user's computer changed since this was approved. Try again.",
    });
  if (asked.browser || asked.newSite) {
    const approved = await approvedSite(ctx, call);
    if (approved !== asked.site) return call.finish({ error: MOVED });
  }
  // The call passed its approval: what it asked is now allowed for this bot, on this computer,
  // in this thread.
  const key = { botId: ctx.bot.id, deviceId: route.deviceId, threadId: ctx.thread.id };
  if (asked.browser) await recordConsent(ctx.deps.prisma, key, "");
  if (asked.newSite && asked.site)
    await recordConsent(ctx.deps.prisma, key, `${asked.verb}:${asked.site}`);
  return undefined;
}

async function userBrowserTool(ctx: RunContext, call: ToolCall, route: Route) {
  const { name, args } = call;
  const refused = await refusal(ctx, call, route);
  if (refused) return refused;
  const asked = userBrowserAsk(args)!;
  const { signal } = ctx.context;
  const first = !providers.has(ctx);
  const provider = providerFor(ctx, route);
  const computer: ComputerRef = {
    id: `user-device-${route.deviceId}`,
    botId: ctx.bot.id,
    kind: "user-device",
    providerRef: route.deviceId,
  };
  const options = { desktopTools: false };
  let result: unknown;
  try {
    // The app keeps each bot's browser under the bot's own folder there, which this sets up.
    await lastValue(
      route.devices.request(
        route.owner,
        { method: "provision", botId: ctx.bot.id, runId: ctx.runId },
        signal,
        route.deviceId,
      ),
    );
    result =
      name === "browser_navigate"
        ? await browserNavigateFromTool(provider, computer, ctx.context, args, options)
        : name === "browser_snapshot"
          ? await browserSnapshotFromTool(provider, computer, ctx.context, args, options)
          : // No saved login, card or upload reaches this browser yet: those steps are refused.
            await (async () => {
              provider.expectedSite = asked.site || undefined;
              return browserActFromTool(provider, computer, ctx.context, args, options);
            })();
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(error instanceof Error ? error.message : "failed", ctx.secrets);
    return call.finish({ error: `The browser on the user's computer did not finish: ${reason}` });
  }
  const page = redactBrowserResult(result, [...ctx.secrets]) as {
    url?: unknown;
    error?: unknown;
    note?: unknown;
  };
  // What a call returns is the page it ended on: only a page of the site it was approved for is
  // given. A look at a page another thread's run moved elsewhere (a blank one included) is
  // refused; a navigation or action that ended on another site (a redirect, a link, a form) says
  // where, and that site is read only once it is asked about.
  const now = typeof page.url === "string" ? pageSite(page.url) : "";
  if (typeof page.url === "string" && page.url) ctx.state.pageUrl = page.url;
  if (now && now !== asked.site) {
    if (name === "browser_snapshot") return call.finish({ error: MOVED });
    return call.finish({
      error: `The page went on to ${now}, which is not shown here until the user allows reading it: call browser_snapshot to ask.`,
    });
  }
  if (first) page.note = [USER_BROWSER_NOTE, page.note].filter(Boolean).join(" ");
  const formatted = browserResultForModel(page);
  if (name !== "browser_snapshot" || page.error || !ctx.computer.acceptsImages)
    return call.finish(formatted);
  const image = await provider.screenshot().catch(() => undefined);
  return call.finish(image ? withScreenshot(formatted, image) : formatted);
}

/** A snapshot with what the page looks like, for a model that can see; as it was if too long. */
function withScreenshot(result: unknown, data: string): unknown {
  const shown = result as AgentToolExecutionResult;
  if (shown?.kind !== "agent_tool_result") return result;
  return {
    ...shown,
    content: [...shown.content, { type: "image", data, mimeType: "image/jpeg" }],
  };
}

/** The site the card of this call named, as its effect keeps it; undefined when it has none. */
async function approvedSite(ctx: RunContext, call: ToolCall): Promise<string | undefined> {
  const effect = await ctx.deps.prisma.externalEffect.findUnique({
    where: { idempotencyKey: call.effectKey },
    select: { id: true, request: true },
  });
  if (!effect) return undefined;
  try {
    const request = readJsonColumn(
      z.object({ [APPROVED_SITE]: z.string() }),
      effect.request,
      { table: "external_effects", column: "request", id: effect.id },
      "reject",
    );
    return request[APPROVED_SITE];
  } catch (error) {
    // An effect from before the site was kept names none: it does not approve a site.
    if (error instanceof JsonColumnMismatchError) return undefined;
    throw error;
  }
}

/**
 * browser_sign_in: the person signs in to a site themselves in the bot's browser on their
 * computer. The app there opens the site's home page and shows them Done and Cancel; nothing of
 * the page reaches the server until they answer, and the bot learns only whether they signed in.
 */
export async function userBrowserSignIn(ctx: RunContext, call: ToolCall) {
  const route = await userBrowserRoute(ctx);
  if (!route) return call.finish({ error: UNAVAILABLE });
  if (userBrowserAsk(call.args)?.site === "")
    return call.finish({ error: "Name the site to sign in to, such as x.com." });
  const refused = await refusal(ctx, call, route);
  if (refused) return refused;
  const asked = userBrowserAsk(call.args)!;
  const { signal } = ctx.context;
  try {
    await lastValue(
      route.devices.request(
        route.owner,
        { method: "provision", botId: ctx.bot.id, runId: ctx.runId },
        signal,
        route.deviceId,
      ),
    );
    const answer = await lastValue(
      route.devices.request<{ signedIn?: unknown }>(
        route.owner,
        { method: "pageBrowserSignIn", botId: ctx.bot.id, runId: ctx.runId, site: asked.site },
        signal,
        route.deviceId,
      ),
    );
    return call.finish({ site: asked.site, signedIn: answer.signedIn === true });
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(error instanceof Error ? error.message : "failed", ctx.secrets);
    return call.finish({ error: `The user's computer did not finish the sign-in: ${reason}` });
  }
}
