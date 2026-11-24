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
  "computer/status": ["bot"],
  "computer/updates": ["bot"],
  "dozoAccessTokens/create": ["bot"],
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
 * Pairs a member or guest sees only when the sweep's own earlier calls happen to have left the
 * thing where the procedure shows it (a run the sweep started, a computer it booted), which a
 * concurrent sweep does not order. Allowed as the table above is, but not required to be seen.
 */
export const DESIGNED_SHARING_SOMETIMES: Readonly<Record<string, readonly string[]>> = {
  "bots/update": ["routineprompt"],
  "computer/boot": ["bot"],
  "export/bot": ["artifact"],
  "runs/list": ["artifact", "bot", "draftskill", "group", "routineprompt", "waitbot"],
};

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
