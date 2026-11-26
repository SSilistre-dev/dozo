import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Runs on the branded tree, where the rules that point the screens at an extra chat have applied.
// Every place the app asks the server about a chat is counted here: each either names the chat
// through the one helper (`dozo-chat-target.ts`) or is main-chat-only on purpose, with the reason.
// A new place fails this until it is put in one list.
const mobile = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const ASKS =
  /["'`](threads\/[A-Za-z]+|dozoQueue\/[A-Za-z]+|dozoChatExport\/[A-Za-z]+)["'`]|subscribeThread\(/;
const asking = Object.fromEntries(
  ["app", "components", "lib"]
    .flatMap((dir) => sources(join(mobile, dir)))
    .map((path) => [relative(mobile, path), readFileSync(path, "utf8")] as const)
    .filter(([, text]) => ASKS.test(text)),
);

/** Names the chat on screen through `dozoChatTarget` (or, for a helper's card, `dozoHelperTarget`). */
const MIGRATED: Record<string, string> = {
  "lib/thread/thread-read.ts": "dozoChatTarget(",
  "lib/thread/thread-live.ts": "dozoChatTarget(",
  "lib/thread/thread-sync.ts": "dozoChatTarget(",
  "lib/thread/thread-window.ts": "dozoChatTarget(",
  "lib/thread/thread-paging.ts": "dozoChatTarget(",
  "lib/thread/send/thread-feedback.ts": "dozoChatTarget(",
  "lib/thread/send/thread-send.ts": "dozoChatTarget(",
  "lib/thread/thread-answer.ts": "dozoChatTarget(",
  "app/peer-chat.tsx": "dozoChatTarget(",
  "components/cards/OutgoingDraftCard.tsx": "dozoChatTarget(",
  "components/cards/ToolQuestionCard.tsx": "dozoChatTarget(",
  "components/thread/thread-run-error.ts": "dozoChatTarget(",
  "components/thread/special-message-card.tsx": "dozoHelperTarget(",
};

/** Not about a chat on screen, or about a bot's main chat only. Why, per file. */
const MAIN_ONLY: Record<string, string> = {
  "lib/api/api-live.ts": "the stream's own type: it takes the target the screen built",
  "lib/api/api.ts":
    "the avatar reads the answer of a read the screen named; consent reads the target's bot",
  "lib/dozo-bot-chats.ts": "names the chat it changes itself, as chatBotId with chatId",
  "lib/dozo-chat-export.ts": "takes the target the caller built, an extra chat's included",
  "lib/dozo-chat-route.ts":
    "asks which thread is the bot's main chat, to tell a notification's chat; it names no chat of its own",
  "lib/dozo-queue.ts":
    "bot or group only: the contract has no chat target, so an extra chat shows no waiting line",
  "lib/calls/call-deps.ts": "a call is the bot's main chat's; an extra chat starts none",
  "lib/calls/incoming-calls.ts": "a call is the bot's main chat's",
  "lib/inbox/preload-chats.ts": "the inbox lists bots and groups, whose chat is the main one",
  "lib/inbox/use-inbox-chat-actions.ts":
    "the inbox lists bots and groups, whose chat is the main one",
  "lib/bots/bot-lifecycle.ts":
    "clearing works in a bot's main chat only; an extra chat is archived",
  "app/bot-settings.tsx": "clearing works in a bot's main chat only; an extra chat is archived",
  "app/computer.tsx": "the computer screen takes over the bot's computer in its main chat",
  "lib/personal-calendar/use-device-calendar.ts":
    "the device calendar is the bot's own, asked by bot and device; no chat is involved",
  "app/(settings)/archived-bots.tsx": "opens an archived bot's main chat to restore it",
};

it("counts every place the app asks about a chat, each migrated or main-chat-only", () => {
  expect(Object.keys(asking).sort()).toEqual(
    [...Object.keys(MIGRATED), ...Object.keys(MAIN_ONLY)].sort(),
  );
});

it.each(Object.entries(MIGRATED))("names the chat through the helper in %s", (file, helper) => {
  expect(asking[file]).toContain(helper);
  // And no longer builds a bot-or-group target by hand beside it.
  expect(asking[file]).not.toMatch(/groupId \? \{ groupId[^}]*\} : \{ botId/);
});

// The screen hands its chat to every hook that asks about it, and leaves out of an extra chat what
// the server answers for the main chat only.
const screen = readFileSync(join(mobile, "components/thread/thread-screen.tsx"), "utf8");
const call = (name: string) => {
  const start = screen.indexOf(`${name}({`);
  expect(start, name).toBeGreaterThan(-1);
  return screen.slice(start, screen.indexOf("});", start));
};

it.each(["useThreadRead", "useThreadSync", "useThreadPaging", "useThreadSend"])(
  "passes the open chat to %s",
  (hook) => {
    expect(call(hook)).toContain("chatId");
  },
);

it("keeps an extra chat out of what is the main chat's: calls, files, the waiting line", () => {
  expect(call("useThreadVoiceCall")).toContain("botId: chatId ? undefined : botId");
  expect(call("useThreadAttachments")).toContain("readOnly: readOnly || Boolean(chatId)");
  expect(call("useIncomingShareImport")).toContain("readOnly: readOnly || Boolean(chatId)");
  expect(screen).toContain("botId={chatId ? undefined : botId}");
  expect(screen).toContain("attachActions={chatId ? [] : attachments.attachActions}");
  expect(screen).toContain("target={chatId ? undefined :");
  expect(screen).toContain("Boolean(botId) && !chatId && call?.botId === botId");
});

it("holds an extra chat's notifications by its own thread, not its bot's main thread", () => {
  expect(screen).toMatch(/snap\?\.threadId \?\? chatId \?\? requestedThreadId/);
  expect(screen).toContain("onCleared: chatId ? () => undefined : history.clear");
  expect(screen).toContain("composerDraftScope(userId, botId, groupId, chatId)");
  expect(screen).toContain("...(chatId ? { chatId } : {})");
  // The title says which chat of the bot it is, and a main chat's title is the bot's name alone.
  expect(screen).toContain("titleName: dozoTitleName(titleName, chatName)");
  expect(screen).toContain("useDozoChatName(botId, chatId)");
});

// What the screen and the files under it key by the chat. Their behavior is run in
// dozo-chat-echo, -window, -read, -sender and -target; these only say the screen uses them.
it("keeps every key and announcement of the chat on screen to the chat's own", () => {
  expect(screen).toContain("dozoEchoedSeqs(snap, { botId, groupId, chatId })");
  expect(screen).not.toContain("(snap.groupId ?? snap.botId) === threadKey");
  expect(screen).toMatch(/: chatId\s*\? undefined\s*: titleBot\?\.threadStatus/);
  const sync = readFileSync(join(mobile, "lib/thread/thread-sync.ts"), "utf8");
  expect(sync).toContain("onRefreshed(dozoChatKey({ botId: targetBotId");
  expect(sync).not.toContain("onRefreshed(targetGroupId ?? targetBotId)");
  const read = readFileSync(join(mobile, "lib/thread/thread-read.ts"), "utf8");
  expect(read).toContain("[botId, groupId, chatId, navigation, readInOrder, readOnly]");
  const card = readFileSync(join(mobile, "components/thread/mcp-app-card.tsx"), "utf8");
  expect(card).toContain("dozoOfferKey(target, chatId)");
  const page = readFileSync(join(mobile, "app/page.tsx"), "utf8");
  expect(page).toContain("dozoPageReplyKey(chat.threadKey, back, params)");
});

// Metro bundles the phone app, which has no Node: a server-only import (`node:*`, the database or
// adapter packages, the logging root that pulls in async_hooks) breaks the Android build, not the
// tests. The phone reports through `./platform/monitoring` or `@rakazo/logging/monitoring`.
it("imports nothing the phone cannot bundle", () => {
  const SERVER_ONLY =
    /^(?!import type\b).*\bfrom\s+["'](node:[^"']*|@rakazo\/(?:db|adapters)(?:\/[^"']*)?|@rakazo\/logging)["']/gm;
  const found = ["app", "components", "lib"]
    .flatMap((dir) => sources(join(mobile, dir)))
    .filter((path) => !/\.test-support\.tsx?$/.test(path))
    .flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(SERVER_ONLY)].map(
        (hit) => `${relative(mobile, path)}: ${hit[1]}`,
      ),
    );
  expect(found).toEqual([]);
});
