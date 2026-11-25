// What the isolation matrix lets a shared Space show: the kinds never shared, and each designed pair.
/**
 * Canary kinds no member or guest of a shared Space may see through any procedure: the owner's
 * keys, secrets, audit log, billing and personal usage, and the owner's own messaging links.
 */
export const NEVER_SHARED_KINDS: readonly string[] = [
  "token",
  "vault",
  "secret",
  "agentsecret",
  "credential",
  "audit",
  "usage",
  "messagingaddress",
];

/**
 * What a shared Space shows its members and guests by design, per procedure and canary kind. A
 * canary of S seen by C or D through a pair not listed here fails the matrix, and so does a pair
 * listed here that no call of the sweep shows: an entry nothing exercises is taken out.
 */
export const DESIGNED_SHARING: Readonly<Record<string, readonly string[]>> = {
  "artifacts/get": ["artifact", "artifactbody"],
  "artifacts/getById": ["artifact", "artifactbody"],
  "artifacts/list": ["artifact", "attachment"],
  "artifacts/listSpace": ["artifact", "attachment"],
  "artifacts/listVersions": ["artifact"],
  bootstrap: [
    "waitbot",
    "artifact",
    "attachment",
    "attachmentmessage",
    "bot",
    "botdescription",
    "callopening",
    "callreason",
    "draftskill",
    "file",
    "group",
    "instructionsnext",
    "memory",
    "message",
    "page",
    "pagebody",
    "queued",
    "routine",
    "routineprompt",
    "secondbot",
    "section",
    "sharedmemory",
  ],
  "bots/duplicate": ["bot", "botdescription", "instructionsnext"],
  "bots/get": ["bot", "botdescription", "instructions", "instructionsnext"],
  "bots/list": [
    "waitbot",
    "bot",
    "botdescription",
    "instructionsnext",
    "secondbot",
  ],
  "bots/update": ["bot", "botdescription", "instructions", "instructionsnext"],
  "botSections/list": ["section"],
  "computer/downloadFile": ["file"],
  "computer/readFile": ["file"],
  "computer/updates": ["bot"],
  "dozoChatExport/markdown": [
    "artifact",
    "attachment",
    "attachmentmessage",
    "bot",
    "chatmessage",
    "file",
    "group",
    "memory",
    "message",
    "page",
    "pagebody",
    "queued",
    "routineprompt",
    "secondbot",
    "sharedmemory",
  ],
  // Only bots the caller made (`dozoTokenOwnBots`): the caller's own copy of S's bot, which
  // `bots/duplicate` above names after its source.
  "dozoAccessTokens/ownBots": ["bot"],
  "dozoChats/list": ["chat"],
  "dozoDailyDigest/set": ["bot"],
  "dozoTeach/decideSaved": ["draftskill"],
  "dozoTeach/save": ["draftskill"],
  "export/bot": [
    "attachment",
    "attachmentmessage",
    "bot",
    "botdescription",
    "callopening",
    "callreason",
    "draftskill",
    "file",
    "instructionsnext",
    "memory",
    "message",
    "page",
    "pagebody",
    "queued",
    "routine",
    "routineprompt",
    "sharedmemory",
  ],
  "groups/create": ["bot", "secondbot"],
  "groups/duplicate": ["bot", "group", "secondbot"],
  "groups/get": ["artifact", "bot", "group", "secondbot"],
  "groups/list": ["artifact", "bot", "group", "secondbot"],
  "groups/update": ["artifact", "bot", "group", "secondbot"],
  "memory/exportMarkdown": ["memory"],
  "memory/list": ["memory"],
  "routines/list": ["routine", "routineprompt"],
  "routines/listForMentions": ["routine", "routineprompt"],
  "scratchpad/list": ["scratchpad"],
  "scratchpad/update": ["scratchpad"],
  "skills/get": ["taught"],
  "skills/list": ["draftskill", "taught"],
  "skills/save": ["draftskill"],
  "skills/updateDraft": ["draftskill"],
  "spaces/list": [
    "waitbot",
    "artifact",
    "bot",
    "botdescription",
    "group",
    "instructionsnext",
    "routineprompt",
    "secondbot",
    "section",
  ],
  "threads/get": [
    "artifact",
    "attachment",
    "attachmentmessage",
    "bot",
    "callopening",
    "callreason",
    "chatmessage",
    "draftskill",
    "file",
    "group",
    "memory",
    "message",
    "page",
    "pagebody",
    "queued",
    "routineprompt",
    "secondbot",
    "sharedmemory",
  ],
  "threads/messages": [
    "artifact",
    "attachment",
    "attachmentmessage",
    "callopening",
    "callreason",
    "chatmessage",
    "draftskill",
    "file",
    "memory",
    "message",
    "page",
    "pagebody",
    "queued",
    "routine",
    "routineprompt",
    "sharedmemory",
  ],
  "threads/subscribe": [
    "artifact",
    "attachment",
    "attachmentmessage",
    "bot",
    "botdescription",
    "chatmessage",
    "draftskill",
    "file",
    "memory",
    "message",
    "page",
    "pagebody",
    "queued",
    "routine",
    "routineprompt",
    "sharedmemory",
    "taught",
  ],
  "tickets/get": ["ticket"],
  "tickets/list": ["ticket"],
  "tickets/move": ["ticket"],
  // The caller's own usage records in S (`usage.breakdown` reads by the caller's user id), named
  // by the bot and routine each was spent on: names the roster and `routines/list` show them too.
  "usage/breakdown": ["bot", "routine", "secondbot"],
};

/**
 * Why a pair is seen only some of the time: under which condition the member or guest is shown
 * the canary through the procedure, and under which not, each naming the code that makes it so.
 */
export type SometimesShared = {
  kinds: readonly string[];
  shownWhen: string;
  hiddenWhen: string;
};

/**
 * Pairs a member or guest sees only when the world the sweep leaves behind happens to hold the
 * thing the procedure shows at the moment of the call: the sweep's own runs (started by calls of
 * C and D, still running when another call reads) and the order they land in are not ordered by
 * the concurrent sweep. Allowed as the table above is, but not required to be seen; each entry
 * says when it is shown and when it is not, and a pair with no such condition belongs in the
 * table above (always shown) or nowhere (never shown).
 */
export const DESIGNED_SHARING_SOMETIMES: Readonly<Record<string, readonly SometimesShared[]>> = {
  "bots/get": [
    {
      kinds: ["routineprompt"],
      shownWhen:
        "The same roster row as `bots/update` below: its `preview` is the newest visible text message of the bot's chat (`botThreadPreviews`, packages/db/src/bots/bot-previews.ts), read by `repos.getBot` in the `bots.get` handler. It carries the routine's prompt while the bot's reply to a routine run (`on it ... i handled: <prompt>`, the scripted runtime) is that newest message.",
      hiddenWhen:
        "The read comes before the routine run has replied or after a newer visible message (another run's reply, a send of the sweep): which of the two a read meets depends on how fast the runs of the file's earlier tests finish, so a slower machine can miss it in every read of the sweep.",
    },
  ],
  "bots/list": [
    {
      kinds: ["routineprompt"],
      shownWhen:
        "The same roster row as `bots/update` below: its `preview` is the newest visible text message of the bot's chat (`botThreadPreviews`, packages/db/src/bots/bot-previews.ts), read by `repos.listBots` in the `bots.list` handler. It carries the routine's prompt while the bot's reply to a routine run (`on it ... i handled: <prompt>`, the scripted runtime) is that newest message.",
      hiddenWhen:
        "The read comes before the routine run has replied or after a newer visible message (another run's reply, a send of the sweep): which of the two a read meets depends on how fast the runs of the file's earlier tests finish, so a slower machine can miss it in every read of the sweep.",
    },
  ],
  "bots/update": [
    {
      kinds: ["routineprompt"],
      shownWhen:
        "The answer is the bot's roster row, whose `preview` is the newest visible text message of the bot's chat (`botThreadPreviews`, packages/db/src/bots/bot-previews.ts, read by `repos.listBots` in the `bots.update` handler, apps/api/src/routes/bots.ts). It carries the routine's prompt when that message is the bot's reply to a routine run, which the scripted runtime writes as `on it ... i handled: <prompt>` (`inferScript`, packages/adapters/src/runtime/scripted-runtime.ts): early in the sweep, while a routine run started before this call (the world is shared with the file's earlier tests) is replying.",
      hiddenWhen:
        "A newer visible message is the chat's preview: the reply to another run (the draft skill's test run, `skills/testRun`) or a message a send of the sweep wrote, or no routine run has replied yet.",
    },
  ],
  "computer/boot": [
    {
      kinds: ["bot"],
      shownWhen:
        "The computer is already running (`state === running` with a `providerRef`), so `computer.boot` skips the lease and answers `computerStatus` (apps/api/src/routes/computer.ts, apps/api/src/computers/computer-control.ts), and a run of the bot holds the computer at that moment, so `resolveComputerWork` (apps/api/src/computers/computer-status.ts) names the bot as busy.",
      hiddenWhen:
        'No run of the bot holds the computer yet or any more (the answer has `busyBotName: null`), or the computer is not in the running state: the full path then needs the lease through `acquireBootLease`, which a live run\'s lease refuses (409 "busy"), or boots it and releases the lease before answering.',
    },
  ],
  "computer/status": [
    {
      kinds: ["bot"],
      shownWhen:
        "`busyBotName` is the bot's name while a run of the bot is active (`ACTIVE_RUN_STATUSES`) and holds the bot's computer lease, or a boot, reset or update holds one with no run (`resolveComputerWork`, apps/api/src/computers/computer-status.ts): the runs C and D's sends, routine and skill test runs started are executing.",
      hiddenWhen:
        "Nothing holds the lease at the read: the first caller's status comes before the runs it started have taken the computer, or the runs have ended (their lease is released a moment after, and a lease of an ended run is not work). The recording the seed leaves holds no execution lease (`takeComputerControl` takes a control lease only).",
    },
  ],
  "export/bot": [
    {
      kinds: ["artifact"],
      shownWhen:
        "The bot's home file `notes/last-task.md` holds the prompt of the last run that reached its second turn, and that run is the group send with the artifact (prompt `User attached file \"<name>\"`, `buildSendPrompt`, apps/api/src/threads/thread-target.ts); `export.bot` lists the home's files (`exportHome`, apps/api/src/routes/content.ts). The generic scripted turn writes the file (`inferScript`, packages/adapters/src/runtime/scripted-runtime.ts).",
      hiddenWhen:
        "A later run of the bot that takes the generic scripted turn (a routine test run, another send) wrote its own prompt over `notes/last-task.md`, or the group send's run had not reached its second turn at the read. The artifact's name is in no message of the bot's own chat: the sends that name it there answer 409 in the sweep, and the group send goes to the group's chat.",
    },
  ],
  // The sweep asks for the `active` filter only (the contract's enum names it first and the input
  // generator takes the first entry), so `listSpaceRuns` (apps/api/src/threads/runs.ts) lists the runs of
  // the Space in `ACTIVE_RUN_STATUSES` that are not background ones, each with the bot's name, the
  // group's name and the task's prompt. The seed's own runs are finished, so every entry below
  // needs a run the sweep started to be queued, leased or running at the read.
  "runs/list": [
    {
      kinds: ["bot"],
      shownWhen:
        "Any run of the bot is in flight at the read (a send, a routine or a draft skill test run started by C's or D's earlier calls): `botName` is on every listed run.",
      hiddenWhen:
        "Every run the sweep started has ended or none is created yet: completed runs are not listed, so the answer is an empty list (D's call, late in the sweep, usually finds it so).",
    },
    {
      kinds: ["draftskill"],
      shownWhen:
        "The draft skill's test run (`skills/testRun`, trigger `skill`, prompt `Run taught skill: <goal> ...`, taught-skills.ts `testRun`) is in flight: its task prompt is the promptSnippet.",
      hiddenWhen:
        "That run has not been created yet (`skills/testRun` comes late in the contract's order) or has ended.",
    },
    {
      kinds: ["routineprompt"],
      shownWhen:
        "A routine test run (`routines/testRun`, `threads/sendWithRoutines`, `createRoutineTestRun` in apps/api/src/routines/routines.ts) is in flight: its task prompt is the routine's prompt.",
      hiddenWhen:
        "No routine run is queued, leased or running at the read: it has ended or none began.",
    },
    {
      kinds: ["group", "artifact"],
      shownWhen:
        'The group send with the artifact (`threads/send` with `groupId` and `artifactIds`) is in flight: its run\'s thread has a group (`groupName`) and its task prompt is `User attached file "<name>"` (`buildSendPrompt`, apps/api/src/threads/thread-target.ts).',
      hiddenWhen:
        "That run has ended or has not begun. The sends that name the artifact in a bot's own chat answer 409 in the sweep, so no other run carries the artifact's name.",
    },
  ],
  "threads/get": [
    {
      kinds: ["routine"],
      shownWhen:
        "The chat's active run was started from the routine (`routines/testRun` or `threads/sendWithRoutines`, trigger `routine`): `routineName` is read with the active runs only (`include: { routine: { select: { name: true } } }`, apps/api/src/threads/thread-snapshot.ts) while the run is queued, leased, running or waiting.",
      hiddenWhen:
        "The run has ended or none was started yet: the failed or finished run a chat shows is read without the routine (`busyOrFailed` has no include), so the name is not in the answer. Members see the routine's name in `routines/list` as well.",
    },
  ],
};
