/**
 * Procedures the isolation matrix does not call, or calls with a known limit, each with the reason.
 * `input`: the generator cannot build a valid input for it, so it is not swept (the matrix fails
 * once it can, so a stale entry is removed). `side-effect`: calling it would break the test world
 * for the caller itself; allowed only for a procedure that names no target (the matrix fails if
 * its input carries an id). `unreached`: still swept, but the owner's own call with the same input
 * does not get through, so a foreign caller's refusal of it proves nothing; `verifiedByCode` then
 * names the filter that keeps foreigners out (`file:line "fragment" — filter`: the file must
 * hold the fragment exactly once, whitespace aside; the line is only where it stood when written),
 * and the matrix fails once the owner gets through. `no-target`: the listed id `fields`
 * name nothing a person keeps (a catalog entry, the caller's own device), so the target's things
 * cannot fill them. `reached-409`: the owner's call answers a conflict, which is listed rather
 * than counted as getting through, with why the handler found the thing first. `distinguishable`:
 * a known finding, a foreigner can tell an existing foreign id from a never-existing one.
 */
export type IsolationExemption = {
  path: string;
  kind: "input" | "side-effect" | "unreached" | "no-target" | "reached-409" | "distinguishable";
  /** For `unreached` and `reached-409`: the one generated input it covers, by its label. */
  variant?: string;
  /** For `no-target`: the id fields that name nothing of the target's. */
  fields?: string[];
  /** For `unreached`: `file:line "fragment" — filter`; the fragment occurs once in the file. */
  verifiedByCode?: string;
  /**
   * For `reached-409`: whether the conflict depends on the computer's state at that moment
   * (starting, busy, stopped), so a run where the owner's call goes through does not make it stale.
   */
  stateDependent?: true;
  reason: string;
};

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
    "instructions",
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
  "bots/get": ["bot", "botdescription", "instructions", "instructionsnext", "routineprompt"],
  "bots/list": [
    "waitbot",
    "bot",
    "botdescription",
    "instructions",
    "instructionsnext",
    "routineprompt",
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
  "dozoChats/list": ["chat"],
  "dozoDailyDigest/set": ["bot"],
  "dozoTeach/decideSaved": ["draftskill"],
  "dozoTeach/save": ["draftskill"],
  "export/bot": [
    "artifactbody",
    "attachment",
    "attachmentbody",
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
  "routines/update": ["routine", "routineprompt"],
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
    "instructions",
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
  "bots/update": [
    {
      kinds: ["routineprompt"],
      shownWhen:
        "The answer is the bot's roster row, whose `preview` is the newest visible text message of the bot's chat (`botThreadPreviews`, packages/db/src/bot-previews.ts, read by `repos.listBots` in the `bots.update` handler, apps/api/src/routes/bots.ts). It carries the routine's prompt when that message is the bot's reply to a routine run, which the scripted runtime writes as `on it ... i handled: <prompt>` (`inferScript`, packages/adapters/src/scripted-runtime.ts): early in the sweep, while a routine run started before this call (the world is shared with the file's earlier tests) is replying.",
      hiddenWhen:
        "A newer visible message is the chat's preview: the reply to another run (the draft skill's test run, `skills/testRun`) or a message a send of the sweep wrote, or no routine run has replied yet.",
    },
  ],
  "computer/boot": [
    {
      kinds: ["bot"],
      shownWhen:
        "The computer is already running (`state === running` with a `providerRef`), so `computer.boot` skips the lease and answers `computerStatus` (apps/api/src/routes/computer.ts, apps/api/src/computer-control.ts), and a run of the bot holds the computer at that moment, so `resolveComputerWork` (apps/api/src/computer-status.ts) names the bot as busy.",
      hiddenWhen:
        'No run of the bot holds the computer yet or any more (the answer has `busyBotName: null`), or the computer is not in the running state: the full path then needs the lease through `acquireBootLease`, which a live run\'s lease refuses (409 "busy"), or boots it and releases the lease before answering.',
    },
  ],
  "computer/status": [
    {
      kinds: ["bot"],
      shownWhen:
        "`busyBotName` is the bot's name while a run of the bot is active (`ACTIVE_RUN_STATUSES`) and holds the bot's computer lease, or a boot, reset or update holds one with no run (`resolveComputerWork`, apps/api/src/computer-status.ts): the runs C and D's sends, routine and skill test runs started are executing.",
      hiddenWhen:
        "Nothing holds the lease at the read: the first caller's status comes before the runs it started have taken the computer, or the runs have ended (their lease is released a moment after, and a lease of an ended run is not work). The recording the seed leaves holds no execution lease (`takeComputerControl` takes a control lease only).",
    },
  ],
  "export/bot": [
    {
      kinds: ["artifact"],
      shownWhen:
        "The bot's home file `notes/last-task.md` holds the prompt of the last run that reached its second turn, and that run is the group send with the artifact (prompt `User attached file \"<name>\"`, `buildSendPrompt`, apps/api/src/thread-target.ts); `export.bot` lists the home's files (`exportHome`, apps/api/src/routes/content.ts). The generic scripted turn writes the file (`inferScript`, packages/adapters/src/scripted-runtime.ts).",
      hiddenWhen:
        "A later run of the bot that takes the generic scripted turn (a routine test run, another send) wrote its own prompt over `notes/last-task.md`, or the group send's run had not reached its second turn at the read. The artifact's name is in no message of the bot's own chat: the sends that name it there answer 409 in the sweep, and the group send goes to the group's chat.",
    },
  ],
  // The sweep asks for the `active` filter only (the contract's enum names it first and the input
  // generator takes the first entry), so `listSpaceRuns` (apps/api/src/runs.ts) lists the runs of
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
        "A routine test run (`routines/testRun`, `threads/sendWithRoutines`, `createRoutineTestRun` in apps/api/src/routines.ts) is in flight: its task prompt is the routine's prompt.",
      hiddenWhen:
        "No routine run is queued, leased or running at the read: it has ended or none began.",
    },
    {
      kinds: ["group", "artifact"],
      shownWhen:
        'The group send with the artifact (`threads/send` with `groupId` and `artifactIds`) is in flight: its run\'s thread has a group (`groupName`) and its task prompt is `User attached file "<name>"` (`buildSendPrompt`, apps/api/src/thread-target.ts).',
      hiddenWhen:
        "That run has ended or has not begun. The sends that name the artifact in a bot's own chat answer 409 in the sweep, so no other run carries the artifact's name.",
    },
  ],
  "threads/get": [
    {
      kinds: ["routine"],
      shownWhen:
        "The chat's active run was started from the routine (`routines/testRun` or `threads/sendWithRoutines`, trigger `routine`): `routineName` is read with the active runs only (`include: { routine: { select: { name: true } } }`, apps/api/src/thread-snapshot.ts) while the run is queued, leased, running or waiting.",
      hiddenWhen:
        "The run has ended or none was started yet: the failed or finished run a chat shows is read without the routine (`busyOrFailed` has no include), so the name is not in the answer. Members see the routine's name in `routines/list` as well.",
    },
  ],
};

/** Whether the table allows a member or guest to see the canary of `kind` through `path` some of the time. */
export const sharedSometimes = (path: string, kind: string) =>
  DESIGNED_SHARING_SOMETIMES[path]?.some((entry) => entry.kinds.includes(kind)) ?? false;

export const ISOLATION_EXEMPTIONS: readonly IsolationExemption[] = [
  {
    path: "skills/start",
    kind: "reached-409",
    reason:
      "The handler found the bot in the caller's Space; the world's own teaching recording is still active when the owner's sweep starts another (\"A teaching session is already active\").",
  },
  {
    path: "models/connect",
    kind: "no-target",
    fields: ["accountId", "gatewayId", "projectId", "modelId", "enabledModelIds"],
    reason:
      "A provider account's, gateway's and project's ids and model names, as the person types them in from the provider: outside values, not stored records of anyone's; `credentialId` names the target's connection.",
  },
  {
    path: "models/connect",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/models.ts:287 "connectModelCredential(context.actor, input, context.signal)" — the connection to replace is looked up for the caller\'s actor',
    reason:
      "The world's model connection is a stored row the generated provider does not match, so its owner is told it is not found (404).",
  },
  {
    path: "computer/downloadFile",
    kind: "reached-409",
    stateDependent: true,
    reason:
      "The handler found the bot and its computer in the caller's Space; a download needs the computer running, which it is not at every point of the owner's sweep (\"Start the computer first\").",
  },
  {
    path: "computer/uploadFile",
    kind: "reached-409",
    stateDependent: true,
    reason:
      "The handler found the bot and its computer in the caller's Space; the computer is stopped at that point of the owner's sweep (\"Start the computer first\").",
  },
  {
    path: "bots/create",
    kind: "distinguishable",
    reason:
      "Known finding: a bot's id is the client's own choice, so a foreigner's create with an existing bot's id fails on the unique id (500) while a never-used id makes the bot (200): whether a bot id exists anywhere can be told apart.",
  },
  {
    path: "computer/stop",
    kind: "reached-409",
    stateDependent: true,
    reason:
      "The handler found the bot's computer in the caller's Space; it is still busy with the owner's previous call (\"Computer is busy\").",
  },
  {
    path: "computer/reset",
    kind: "reached-409",
    stateDependent: true,
    reason:
      "The handler found the bot's computer in the caller's Space; it is still busy with the owner's previous call (\"Computer is busy\").",
  },
  {
    path: "computer/release",
    kind: "reached-409",
    reason:
      'The handler found the bot in the caller\'s Space and its computer; the run the input names is not waiting for an answer from the person ("The bot is no longer waiting").',
  },
  {
    path: "models/finishOAuth",
    kind: "reached-409",
    reason:
      'The handler found the sign-in session by its id, Space and person; the outside sign-in it waits for never finished in tests ("Sign-in has not finished yet").',
  },
  {
    path: "bots/restoreInstructions",
    kind: "reached-409",
    reason:
      'The handler found the bot in the caller\'s Space; restoring needs the instructions the client last saw, which a generated input cannot know ("Instructions changed").',
  },
  {
    path: "dozoMessages/edit",
    kind: "reached-409",
    reason:
      "The handler found the message in the bot's chat; only the latest message can be changed (MESSAGE_NOT_REVISABLE).",
  },
  {
    path: "dozoMessages/regenerate",
    kind: "reached-409",
    reason:
      "The handler found the message in the bot's chat; only the latest answer can be made again (MESSAGE_NOT_REVISABLE).",
  },
  {
    path: "threads/answer",
    kind: "reached-409",
    reason:
      'The handler found the message; it is not a prompt still waiting for an answer ("This prompt is no longer awaiting an answer").',
  },
  {
    path: "dozoSiteSessions/signIn",
    kind: "reached-409",
    stateDependent: true,
    reason:
      "The handler found the bot and its computer in the caller's Space; the computer is stopped at that point of the owner's sweep (\"Start the computer first\").",
  },
  {
    path: "dozoSiteSessions/signOut",
    kind: "reached-409",
    stateDependent: true,
    reason:
      "The handler found the bot and its computer in the caller's Space; the computer is stopped at that point of the owner's sweep (\"Start the computer first\").",
  },
  {
    path: "computer/recover",
    kind: "reached-409",
    stateDependent: true,
    reason:
      "The handler found the bot's computer in the caller's Space; it is still busy with the owner's previous call (\"Computer is busy\").",
  },
  {
    path: "computer/update",
    kind: "reached-409",
    stateDependent: true,
    reason:
      "The handler found the bot's computer in the caller's Space; it is still busy with the owner's previous call (\"Computer is busy\").",
  },
  {
    path: "agentSkills/update",
    kind: "reached-409",
    reason:
      "The handler found the skill in the caller's Space; the generated new name is taken by the skill the owner's own create made earlier in the sweep.",
  },
  {
    path: "dozoAdmin/accessGrants/update",
    kind: "no-target",
    fields: ["id"],
    reason:
      "An access grant: a server-wide record a server admin keeps for an email address, owned by no Space or person in the world.",
  },
  {
    path: "dozoAdmin/accessGrants/delete",
    kind: "no-target",
    fields: ["id"],
    reason:
      "An access grant: a server-wide record a server admin keeps for an email address, owned by no Space or person in the world.",
  },
  {
    path: "accessGrants/revoke",
    kind: "no-target",
    fields: ["id"],
    reason:
      "An access grant: a server-wide record a server admin keeps for an email address, owned by no Space or person in the world.",
  },
  {
    path: "marketplace/review",
    kind: "no-target",
    fields: ["id"],
    reason:
      "A plugin submission to the server's marketplace: a server-wide record only a server admin reviews, owned by no Space or person in the world.",
  },
  {
    path: "dozoTeach/removeTarget",
    kind: "no-target",
    fields: ["targetId"],
    reason:
      "The number of one click's picture inside the taught skill that `skillId` names; `skillId` is filled with the target's skill, so the target is named through it.",
  },
  {
    path: "models/setRole",
    kind: "no-target",
    fields: ["modelId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's.",
  },
  {
    path: "models/setBackups",
    kind: "no-target",
    fields: ["modelId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's.",
  },
  {
    path: "dozoBotModelBackups/set",
    kind: "no-target",
    fields: ["modelId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's; `botId` names the target's bot and `credentialId` the target's connection.",
  },
  {
    path: "models/beginOAuth",
    kind: "no-target",
    fields: ["modelId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's.",
  },
  {
    path: "models/setDefault",
    kind: "no-target",
    fields: ["modelId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's.",
  },
  {
    path: "models/saveModelSettings",
    kind: "no-target",
    fields: ["modelId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's.",
  },
  {
    path: "routines/create",
    kind: "no-target",
    fields: ["modelId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's.",
  },
  {
    path: "routines/update",
    kind: "no-target",
    fields: ["modelId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's.",
  },
  {
    path: "bots/update",
    kind: "no-target",
    fields: ["voiceId", "modelId"],
    reason:
      "A voice and a model by their names in a provider's catalog, not stored records of anyone's; `botId` names the target's bot.",
  },
  {
    path: "voice/connect",
    kind: "no-target",
    fields: ["voiceId"],
    reason: "A voice by its name in the voice provider's catalog, not a stored record of anyone's.",
  },
  {
    path: "voice/setVoice",
    kind: "no-target",
    fields: ["voiceId"],
    reason: "A voice by its name in the voice provider's catalog, not a stored record of anyone's.",
  },
  {
    path: "voice/prepare",
    kind: "no-target",
    fields: ["voiceId"],
    reason: "A voice by its name in the voice provider's catalog, not a stored record of anyone's.",
  },
  {
    path: "bots/createFromTemplate",
    kind: "no-target",
    fields: ["templateId"],
    reason: "A bot template's slug from the server's built-in template catalog.",
  },
  {
    path: "computer/releaseInterrupted",
    kind: "no-target",
    fields: ["id"],
    reason:
      "An interrupted computer job's id; the handler answers FORBIDDEN to every caller before it reads its input (apps/api/src/routes/computer.ts, releaseInterrupted).",
  },
  {
    path: "mcp/servers/create",
    kind: "no-target",
    fields: ["clientId"],
    reason:
      "The OAuth client id the person types in for a tool server: an outside provider's value, not a stored record.",
  },
  {
    path: "mcp/servers/update",
    kind: "no-target",
    fields: ["clientId"],
    reason:
      "The OAuth client id the person types in for a tool server: an outside provider's value, not a stored record.",
  },
  {
    path: "onboarding/choose",
    kind: "no-target",
    fields: ["optionId"],
    reason: "One of onboarding's fixed choices, from the server's own list.",
  },
  {
    path: "onboarding/appConnected",
    kind: "no-target",
    fields: ["connectorId"],
    reason:
      "An app's id in the integrations catalog (the product's catalog data), not a stored record of anyone's.",
  },
  {
    path: "connections/catalog",
    kind: "no-target",
    fields: ["connectorId"],
    reason:
      "An app's id in the integrations catalog (the product's catalog data), not a stored record of anyone's.",
  },
  {
    path: "connections/begin",
    kind: "no-target",
    fields: ["connectorId"],
    reason:
      "An app's id in the integrations catalog (the product's catalog data), not a stored record of anyone's.",
  },
  {
    path: "connections/tools",
    kind: "no-target",
    fields: ["connectorId"],
    reason:
      "An app's id in the integrations catalog (the product's catalog data), not a stored record of anyone's.",
  },
  {
    path: "notifications/registerCallPush",
    kind: "no-target",
    fields: ["deviceId"],
    reason: "The caller's own phone's id, which the phone makes up and sends to register itself.",
  },
  {
    path: "security/events",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/account.ts:281 "events: authed.security.events.handler(() => { throw new ORPCError(" \u2014 answers FORBIDDEN to every caller before reading its input',
    reason: "Answers FORBIDDEN to every app account (403); it has no handler that reads its input.",
  },
  {
    path: "dozoAdmin/user",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/dozo-admin.ts:107 "await requireAdmin(deps, context.actor.userId);" \u2014 every admin procedure refuses a caller who is not a server admin',
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/rename",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/dozo-admin.ts:107 "await requireAdmin(deps, context.actor.userId);" \u2014 every admin procedure refuses a caller who is not a server admin',
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/setPlan",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/dozo-admin.ts:107 "await requireAdmin(deps, context.actor.userId);" \u2014 every admin procedure refuses a caller who is not a server admin',
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/endSessions",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/dozo-admin.ts:107 "await requireAdmin(deps, context.actor.userId);" \u2014 every admin procedure refuses a caller who is not a server admin',
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/setSuspended",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/dozo-admin.ts:107 "await requireAdmin(deps, context.actor.userId);" \u2014 every admin procedure refuses a caller who is not a server admin',
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/deleteUser",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/dozo-admin.ts:107 "await requireAdmin(deps, context.actor.userId);" \u2014 every admin procedure refuses a caller who is not a server admin',
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/ban",
    kind: "unreached",
    variant: "option 0",
    verifiedByCode:
      'apps/api/src/dozo-admin.ts:107 "await requireAdmin(deps, context.actor.userId);" \u2014 every admin procedure refuses a caller who is not a server admin',
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "artifacts/get",
    kind: "unreached",
    variant: "groupId",
    verifiedByCode:
      'apps/api/src/routes/content.ts:81 "groupRepos.getGroupTarget(context.actor, input.groupId)" \u2014 the group is looked up in the caller\'s Space',
    reason:
      "P's artifact belongs to the bot's own chat, so named through the group it is not found for its owner either (404); the botId input reaches it.",
  },
  {
    path: "artifacts/get",
    kind: "unreached",
    variant: "chatBotId+chatId",
    verifiedByCode:
      'apps/api/src/routes/content.ts:79 "get: authed.artifacts.get.handler(async ({ context, input }) => { dozoBotOrGroupOnly(input);" \u2014 an extra chat is refused before any lookup',
    reason:
      "Refused by design before any lookup (400 dozo_extra_chat_not_a_target): an extra chat is not a target here.",
  },
  {
    path: "artifacts/create",
    kind: "unreached",
    variant: "chatBotId+chatId",
    verifiedByCode:
      'apps/api/src/routes/content.ts:60 "create: authed.artifacts.create.handler(async ({ context, input }) => { dozoBotOrGroupOnly(input);" \u2014 an extra chat is refused before any lookup',
    reason:
      "Refused by design before any lookup (400 dozo_extra_chat_not_a_target): an extra chat is not a target here.",
  },
  {
    path: "botSections/create",
    kind: "unreached",
    variant: "chatBotId+chatId",
    verifiedByCode:
      'apps/api/src/routes/bots.ts:903 "repos.createBotSection(context.actor, dozoBotOrGroupOnly(input))" \u2014 an extra chat is refused before any lookup; the bot through the caller\'s actor',
    reason:
      "Refused by design before any lookup (400 dozo_extra_chat_not_a_target): an extra chat is not a target here.",
  },
  {
    path: "threads/clear",
    kind: "unreached",
    variant: "chatBotId+chatId",
    verifiedByCode:
      'apps/api/src/routes/threads.ts:325 "clear: authed.threads.clear.handler(async ({ context, input }) => { const target = await resolveThreadTarget(deps.prisma, context.actor, input);" \u2014 the chat is resolved in the caller\'s Space',
    reason:
      "Refused by design before any lookup (400 dozo_extra_chat_unsupported): clearing works in a bot's main chat only.",
  },
  {
    path: "threads/react",
    kind: "unreached",
    variant: "groupId",
    verifiedByCode:
      "apps/api/src/routes/threads.ts:288 \"react: authed.threads.react.handler(async ({ context, input }) => { const target = await resolveThreadTarget(deps.prisma, context.actor, input);\" \u2014 the group's chat is resolved in the caller's Space",
    reason:
      "P's messages live in the bot's chats, none in the group's, so the message is not found for its owner either (404); the botId and chat inputs reach it.",
  },
  {
    path: "threads/markUnread",
    kind: "unreached",
    variant: "groupId+messageId",
    verifiedByCode:
      "apps/api/src/routes/threads.ts:639 \"markUnread: authed.threads.markUnread.handler(async ({ context, input }) => { const target = await resolveThreadTarget(deps.prisma, context.actor, input);\" \u2014 the group's chat is resolved in the caller's Space",
    reason:
      "P's messages live in the bot's chats, none in the group's, so the message is not found for its owner either (404); the botId input reaches it.",
  },
  {
    path: "spaces/remove",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/spaces.ts:121 "remove: authed.spaces.remove.handler(({ context, input }) => asMemberOf(deps.prisma, context.actor, input.spaceId" \u2014 only a member of the named Space gets past',
    reason: "P is A's default Space, which cannot be deleted (400).",
  },
  {
    path: "spaces/members/remove",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/spaces.ts:155 "remove: authed.spaces.members.remove.handler(({ context, input }) => asMemberOf(deps.prisma, context.actor, input.spaceId" \u2014 only a member of the named Space gets past',
    reason: "P's only member is A, its owner, who cannot be removed (400).",
  },
  {
    path: "spaces/members/leave",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/spaces.ts:176 "leave: authed.spaces.members.leave.handler(({ context, input }) => asMemberOf(deps.prisma, context.actor, input.spaceId" \u2014 only a member of the named Space gets past',
    reason: "A owns P, and an owner cannot leave (400).",
  },
  {
    path: "bots/create",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/bots.ts:412 "const bot = await repos.createBot(context.actor, {" \u2014 the bot is made in the caller\'s own Space',
    reason:
      "Its id is the new bot's own; P's bot id is taken, so the owner's create fails on the unique id too (answers 500, not 409).",
  },
  {
    path: "bots/claimEmailAddress",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/bots.ts:722 "claimEmailAddress: authed.bots.claimEmailAddress.handler(async ({ context, input }) => { const bot = await repos.getBot(context.actor, input.botId);" \u2014 the bot is looked up in the caller\'s Space',
    reason:
      "The test server receives no email, so every caller is refused before the bot is looked up (400).",
  },
  {
    path: "messaging/installations/start",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/messaging.ts:30 "deps.messagingInstallations.start(context.actor, input.botId)" \u2014 the provider gets the caller\'s actor; no provider runs in tests',
    reason:
      "No messaging app installation provider is configured in tests, so every caller is refused before the bot is looked up (400).",
  },
  {
    path: "dozoModelPool/set",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/dozo-model-pool.ts:27 "setDozoModelPool(poolDeps, context.actor.userId, input)" \u2014 the connection is looked up by the caller\'s own account',
    reason:
      "The world's model connection is a stored row without a working provider, which cannot hand over to another (400).",
  },
  {
    path: "models/setRole",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/routes/models.ts:247 "await validateRoleChoices(context.actor, role, [" \u2014 the choices are checked against the caller\'s own connections',
    reason:
      "The world's model connection has no provider set up, so the owner's choice is refused (400).",
  },
  {
    path: "dozoBotModelBackups/set",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/dozo-bot-model-backups.ts:21 "set: authed.dozoBotModelBackups.set.handler(async ({ context, input }) => { const bot = await repos.getBot(context.actor, input.botId);" \u2014 the bot is looked up in the caller\'s own Space before anything is read or written',
    reason:
      "The world's model connection has no provider set up, so the owner's backup row is refused (400), as for `models/setRole`.",
  },
  {
    path: "models/probeOpenAiCompatible",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/routes/models.ts:307 "where: { userId: context.actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID }," \u2014 connections are read for the caller\'s own account',
    reason: "Probing needs a reachable base URL, which a test with no network has not (400).",
  },
  {
    path: "models/beginOAuth",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/routes/models.ts:376 "const target = await modelConnectionTarget( deps, context.actor," \u2014 the connection is looked up for the caller\'s actor (next lines)',
    reason:
      "The world's model connection is not one an outside sign-in can renew (404 for its owner too).",
  },
  {
    path: "models/submitOAuthCode",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/routes/models.ts:416 ".submit(input.loginId, context.actor" \u2014 the sign-in session is looked up for the caller\'s actor',
    reason:
      "The world's sign-in session never reached the outside provider, so its owner is told to start again (400).",
  },
  {
    path: "models/saveModelSettings",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/routes/models.ts:631 "saveConnectionModelSettings(deps, context.actor, input)" \u2014 the connection is looked up for the caller\'s actor',
    reason:
      "The world's model connection holds a placeholder secret the secret store cannot read (500 for its owner too).",
  },
  {
    path: "bots/importCreate",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/routes/bots.ts:423 "createImportedBot(agentImportServices, context.actor, input" \u2014 the import runs as the caller in the caller\'s Space',
    reason:
      "An import needs the files its preview read; a generated selection does not match them (400).",
  },
  {
    path: "capabilities/pluginParts",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/plugin-installs.ts:398 "...availableInSpace(actor), id: input.id" \u2014 the install is looked up among those of the caller\'s Space',
    reason:
      "The world's capability is a stored row, not a plugin whose parts were read from a repository (404).",
  },
  {
    path: "mcp/servers/update",
    kind: "unreached",
    variant: "option 0",
    verifiedByCode:
      'apps/api/src/routes/mcp.ts:112 "const existing = await tx.mcpServer.findFirst({ where: { id: input.id, ...availableInSpace(context.actor), }," \u2014 the server is looked up among those of the caller\'s Space',
    reason: "The generated remote endpoint has no address in a test with no network (400).",
  },
  {
    path: "mcp/oauth/begin",
    kind: "unreached",

    verifiedByCode:
      "apps/api/src/routes/mcp.ts:598 \"return await mcpOAuth.begin({ ...input, redirectUri: expectedRedirect, spaceId: context.actor.spaceId,\" \u2014 the server and session are the caller's Space's",
    reason:
      "Beginning a sign-in reaches the tool server's address, which a test with no network has not (400).",
  },
  {
    path: "mcp/oauth/complete",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/routes/mcp.ts:621 "await mcpOAuth.complete({ ...input, spaceId: context.actor.spaceId," \u2014 the session is looked up in the caller\'s Space',
    reason: "The world's sign-in session holds a placeholder the server cannot open (400).",
  },
  {
    path: "messaging/link/start",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/routes/messaging.ts:73 "space: { memberships: { some: { userId: context.actor.userId } } }," \u2014 the bot must be the caller\'s, in a Space the caller is in',
    reason:
      "The world already linked the bot to a messaging identity, so its owner is told to unlink it first (400).",
  },
  {
    path: "dozoFeedback/send",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/dozo-feedback.ts:96 "failedRuns(deps.prisma, context.actor, now(), input.diagnostics.runIds)" \u2014 named runs are read through the caller\'s actor',
    reason: "Feedback needs a receiving address and mail, which tests do not set up (404).",
  },
  {
    path: "dozoAdmin/stopComputer",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/dozo-admin.ts:107 "await requireAdmin(deps, context.actor.userId);" \u2014 every admin procedure refuses a caller who is not a server admin',
    reason: "A server admin's procedure: no person in the world is a server admin (403).",
  },
  {
    path: "connections/revoke",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/connection-flows.ts:576 "const snapshot = await deps.prisma.connection.findFirst({ where: { id: input.connectionId, spaceId: context.actor.spaceId, userId: context.actor.userId, }," \u2014 the connection is looked up for the caller in the caller\'s Space',
    reason: "Revoking reaches the connection's provider, which tests do not configure (400).",
  },
  {
    path: "messaging/installations/remove",
    kind: "unreached",

    verifiedByCode:
      'apps/api/src/routes/messaging.ts:43 "deps.messagingInstallations.remove(context.actor, input.id)" \u2014 the provider gets the caller\'s actor',
    reason:
      "No messaging app installation provider is configured in tests, so every caller is refused before the installation is looked up (400).",
  },
];
