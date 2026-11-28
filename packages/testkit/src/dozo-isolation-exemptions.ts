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
    path: "organizations/invitations/preview",
    kind: "distinguishable",
    reason:
      "Known finding, by design: an invitation's id is the secret of its link, which only the address it is for receives. Whoever holds an id learns that the invitation exists and is for another address (403 against 404), never which address: the answer does not name it (organization-members.ts, OrganizationInvitationEmailError).",
  },
  {
    path: "organizations/invitations/accept",
    kind: "distinguishable",
    reason:
      "Known finding, by design: an invitation's id is the secret of its link, which only the address it is for receives. Whoever holds an id learns that the invitation exists and is for another address (403 against 404), never which address: the answer does not name it (organization-members.ts, OrganizationInvitationEmailError).",
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
  { path: "pageApps/remove", kind: "no-target", fields: ["appId"], reason: "An installed page app, which exists only once its owner's device holds the token issued at install, so no record of the target's fills it. The delete is filtered by the caller's own user id and answers the same for any id, so a foreign id removes nothing and tells nothing." },
  {
    path: "dozoShareLinks/create",
    kind: "no-target",
    fields: ["targetId"],
    reason: "What a link shows depends on its kind; none ships yet, so no create succeeds.",
  },
  {
    path: "dozoTeach/removeTarget",
    kind: "no-target",
    fields: ["targetId"],
    reason:
      "The number of one click's picture inside the taught skill that `skillId` names; `skillId` is filled with the target's skill, so the target is named through it.",
  },
  {
    path: "models/setMedia",
    kind: "no-target",
    fields: ["modelId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's; `credentialId` names the target's connection.",
  },
  {
    path: "models/deployment/update",
    kind: "no-target",
    fields: ["modelId"],
    reason:
      "A model's name in a provider's catalog, for the server's own default model: a server-wide setting an admin keeps, owned by no Space or person in the world.",
  },
  {
    path: "mcp/servers/createForBots",
    kind: "no-target",
    fields: ["clientId"],
    reason:
      "The OAuth client id the person types in for a tool server: an outside provider's value, not a stored record; `botIds` name the target's bots.",
  },
  {
    path: "mcp/servers/save",
    kind: "no-target",
    fields: ["clientId"],
    reason:
      "The OAuth client id the person types in for a tool server: an outside provider's value, not a stored record; `id` names the target's server.",
  },
  {
    path: "threads/nativeCalendarClaim",
    kind: "no-target",
    fields: ["id"],
    reason:
      "A request for the calendar of the caller's own phone, bound to one native session of that phone and to a running chat of the caller's: the world signs in on the web, which has no native session, so no request can exist (apps/api/src/routes/threads.ts, calendarDevice).",
  },
  {
    path: "threads/nativeCalendarResult",
    kind: "no-target",
    fields: ["id"],
    reason:
      "A request for the calendar of the caller's own phone, bound to one native session of that phone and to a running chat of the caller's: the world signs in on the web, which has no native session, so no request can exist (apps/api/src/routes/threads.ts, calendarDevice).",
  },
  {
    path: "meetingCalendar/select",
    kind: "no-target",
    fields: ["eventId"],
    reason:
      "An event of the person's connected outside calendar, named by the calendar provider's own id, not a stored record; `botId` names the target's bot, looked up first.",
  },
  {
    path: "meetingCalendar/skip",
    kind: "no-target",
    fields: ["eventId"],
    reason:
      "An event of the person's connected outside calendar, named by the calendar provider's own id, not a stored record; `botId` names the target's bot, looked up first.",
  },
  {
    path: "meetingCalendar/removeSeries",
    kind: "no-target",
    fields: ["eventId"],
    reason:
      "An event of the person's connected outside calendar, named by the calendar provider's own id, not a stored record; `botId` names the target's bot, looked up first.",
  },
  {
    path: "pageReviews/comment",
    kind: "no-target",
    fields: ["submissionId"],
    reason:
      "A random id the client makes up for one comment submission, so a repeat is told from a new one; it names nothing stored until the comment exists, and `pageId` names the target's page.",
  },
  {
    path: "pageReviews/draft",
    kind: "no-target",
    fields: ["requestId"],
    reason:
      "A revision request of a comment on the page that `pageId` names, looked up under that page; `pageId` is filled with the target's page, so the target is named through it. A request needs a model to draft it, which the world has none of.",
  },
  {
    path: "pageReviews/publish",
    kind: "no-target",
    fields: ["requestId"],
    reason:
      "A revision request of a comment on the page that `pageId` names, looked up under that page; `pageId` is filled with the target's page, so the target is named through it. A request needs a model to draft it, which the world has none of.",
  },
  {
    path: "pageReviews/image",
    kind: "no-target",
    fields: ["imageId"],
    reason:
      "A picture of the page version that `pageId` and `version` name, looked up under that version; `pageId` is filled with the target's page, so the target is named through it. A picture needs stored bytes the world has none of.",
  },
  {
    path: "models/setRole",
    kind: "no-target",
    fields: ["modelId", "creditOfferingId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's. A hosted-credit offering is one the server's own configuration lists, not a stored record of anyone's.",
  },
  {
    path: "models/setBackups",
    kind: "no-target",
    fields: ["modelId", "creditOfferingId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's. A hosted-credit offering is one the server's own configuration lists, not a stored record of anyone's.",
  },
  {
    path: "dozoBotModelBackups/set",
    kind: "no-target",
    fields: ["modelId", "creditOfferingId"],
    reason:
      "A model's name in a provider's catalog (what to run), not a stored record of anyone's; `botId` names the target's bot and `credentialId` the target's connection. A hosted-credit offering is one the server's own configuration lists, not a stored record of anyone's.",
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
    path: "connections/beginForOrganization",
    kind: "no-target",
    fields: ["connectorId"],
    reason:
      "An app's id in the integrations catalog (the product's catalog data), not a stored record of anyone's.",
  },
  {
    path: "mcp/servers/createForOrganization",
    kind: "no-target",
    fields: ["clientId"],
    reason:
      "The OAuth client id the person types in for a tool server: an outside provider's value, not a stored record.",
  },
  {
    path: "models/organizationConnections/create",
    kind: "no-target",
    fields: ["accountId", "gatewayId", "projectId", "modelId", "enabledModelIds", "credentialId"],
    reason:
      "A provider account's, gateway's and project's ids and model names, as the admin types them in from the provider: outside values, not stored records of anyone's. `credentialId` is `z.never()`: the input refuses any value, as a new organization connection never reuses a person's own.",
  },
  {
    path: "connections/reconnectOrganization",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/integrations/connection-complete.ts:375 "const row = await findManagedConnection(deps.prisma, context.actor, connectionId);" — the connection is one of the caller\'s own or of the organization the caller manages',
    reason:
      "The handler found the organization's connection for its admin; no integration provider is configured in tests, so the owner is refused after that (400).",
  },
  {
    path: "organizations/vault/signIn",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/organization-vault.ts:135 "const login = await tx.organizationLogin.findFirst({ where: { id: input.loginId, organizationId }," — the login is looked up in the organization the caller manages',
    reason:
      "The handler found the organization's login for its admin; no protected browser is configured in tests, so the owner is refused after that (400).",
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
      'apps/api/src/routes/models.ts:202 "await validateRoleChoices( context.actor, role, [...(primary ? [primary] : []), ...(backups ?? [])], reads, );" \u2014 the choices are checked against the caller\'s own connections',
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
      'apps/api/src/integrations/plugin-installs.ts:447 "const existing = await deps.prisma.capabilityInstall.findFirst({ where: { ...personalOrOrganizationItemIn(actor), id: input.id, kind: "plugin", }, });" — the install is looked up among those of the caller\'s Space and of the caller\'s organization',
    reason:
      "The world's capability is a stored row, not a plugin whose parts were read from a repository (404).",
  },
  {
    path: "mcp/servers/update",
    kind: "unreached",
    variant: "option 0",
    verifiedByCode:
      'apps/api/src/routes/mcp.ts:207 "const existing = await tx.mcpServer.findFirst({ where: { id: input.id, ...managed }, });" — the server is looked up among those of the caller\'s Space and, for an admin, of the organization the caller manages',
    reason: "The generated remote endpoint has no address in a test with no network (400).",
  },
  {
    path: "mcp/oauth/begin",
    kind: "unreached",

    verifiedByCode:
      "apps/api/src/routes/mcp.ts:440 \"return await mcpOAuth.begin({ ...input, redirectUri: expectedRedirect, spaceId: actor.spaceId, userId: actor.userId, });\" \u2014 the server and session are the caller's Space's",
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
      "apps/api/src/integrations/connection-flows.ts:540 \"const snapshot = await findManagedConnection(deps.prisma, context.actor, input.connectionId);\" — the connection is the caller's own in the caller's Space, or one of the organization the caller manages",
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
  {
    path: "aiConsent/allow",
    kind: "reached-409",
    reason:
      "The handler read the page's review settings as the caller first (aiConsentStatus with the page id, which only the page's owner or a reviewer passes); the generated scope and version are not the ones that review showed (\"AI data sharing changed. Review it again.\").",
  },
  {
    path: "cloudComputers/setSize",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/account.ts:108 "await billing.setComputerSize(context.actor, input.computerId, input.size);" — the computer is looked up for the caller\'s actor, after the billing check',
    reason:
      "No billing provider is configured in tests, so every caller is refused before the computer is looked up (404).",
  },
  {
    path: "computer/restoreHomeVersion",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/computer.ts:381 "restoreHomeVersion: authed.computer.restoreHomeVersion.handler(async ({ context, input }) => { const computer = (await repos.getBot(context.actor, input.botId)).computer;" — the bot is read for the caller\'s actor before anything else',
    reason:
      "The handler found the bot and its computer in the caller's Space; the world's computer keeps no earlier versions of its home, so the owner is refused after that (400).",
  },
  {
    path: "connections/complete",
    kind: "unreached",
    verifiedByCode:
      "apps/api/src/integrations/connection-complete.ts:45 \"const existing = await findManagedConnection(deps.prisma, context.actor, input.connectionId);\" — the connection is the caller's own in the caller's Space, or one of the organization the caller manages",
    reason:
      "The handler found the owner's connection; the world's connection names a connector no provider serves in tests, so completing it is refused after that (400).",
  },
  {
    path: "mcp/servers/connect",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/integrations/mcp-servers.ts:116 "throw new ConnectionSetupError("Connector URL host could not be found", { cause: error });" — the generated address is refused for every caller before any server row is read; the rows it then reads are availableInSpace(actor)',
    reason:
      "The generated server address names a host that does not exist, so every caller is refused when the address is checked (400), before any stored server is looked up.",
  },
  {
    path: "mcp/servers/createForBots",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/mcp.ts:71 "if (botIds) await chooseMcpServerBots(tx, actor, row.id, botIds);" — the bots are chosen as the caller\'s actor, after the address check',
    reason:
      "The generated server address names a host that does not exist, so every caller is refused when the address is checked (400), before the bots are looked up.",
  },
  {
    path: "mcp/servers/save",
    kind: "unreached",
    verifiedByCode:
      "apps/api/src/routes/mcp.ts:198 \"async function updateMcpServer( actor: Actor, input: { id: string; config: McpServerConfigInput } | { id: string; secret: string }, access?: { allBots: boolean; botIds: string[] }, ) { const viewer = await mcpViewer(deps.prisma, actor); const managed = personalOrManagedOrganizationItemIn(actor, viewer.managedOrganizationId);\" — the server is found among those available in the caller's Space and, for an admin, the organization's",
    reason:
      "The handler found the owner's server; the generated address names a host that does not exist, so the save is refused when the address is checked (400).",
  },
  {
    path: "meetingCalendar/begin",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/meetings/calendar/calendar-routes.ts:45 "async ({ context: { actor, sessionId }, input }) => { await repos.getBot(actor, input.botId); return configured().authorization.begin(" — the bot is read for the caller\'s actor first',
    reason:
      "The handler found the bot in the caller's Space; no calendar provider is configured in tests, so the owner is refused after that (404).",
  },
  {
    path: "meetingCalendar/select",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/meetings/calendar/calendar-routes.ts:72 "select: authed.meetingCalendar.select.handler(async ({ context: { actor }, input }) => { await repos.getBot(actor, input.botId);" — the bot is read for the caller\'s actor first',
    reason:
      "The handler found the bot in the caller's Space; no calendar provider is configured in tests, so the owner is refused after that (404).",
  },
  {
    path: "meetingCalendar/skip",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/meetings/calendar/calendar-routes.ts:47 "await repos.getBot(actor, input.botId); await configured().updateSelection(actor, input.botId, input.eventId, "skip");" — the bot is read for the caller\'s actor first',
    reason:
      "The handler found the bot in the caller's Space; no calendar provider is configured in tests, so the owner is refused after that (404).",
  },
  {
    path: "meetingCalendar/removeSeries",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/meetings/calendar/calendar-routes.ts:47 "await repos.getBot(actor, input.botId); await configured().updateSelection(actor, input.botId, input.eventId, "removeSeries");" — the bot is read for the caller\'s actor first',
    reason:
      "The handler found the bot in the caller's Space; no calendar provider is configured in tests, so the owner is refused after that (404).",
  },
  {
    path: "meetings/ask",
    kind: "unreached",
    verifiedByCode:
      "apps/api/src/meetings/meeting-routes.ts:8 \"const { turns, botId } = await requireMeetings().transcript(context.actor, input.id);\" — the meeting's transcript is read for the caller's actor first",
    reason:
      "The handler read the owner's meeting transcript; answering needs a connected model, which the world's owner has none of for this (400).",
  },
  {
    path: "meetings/join",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/meetings/meeting-routes.ts:20 "requireMeetings().join(context.actor, input.botId, input.url, input.shareTranscript)" — the meeting service gets the caller\'s actor',
    reason:
      "Meetings are not enabled for any Space in tests, so every caller is refused before the bot is looked up (403).",
  },
  {
    path: "models/setBackups",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/context.ts:94 "throw new ORPCError("BAD_REQUEST", { message: "Connect that model provider first" });" — the connection is looked up with findConnectedModelCredential for the caller\'s actor just above',
    reason:
      "The world's model connection is a stored row the generated provider does not match, so its owner is told to connect that provider first (400).",
  },
  {
    path: "models/setMedia",
    kind: "unreached",
    verifiedByCode:
      'packages/adapters/src/media/media-model-choices.ts:23 "const connection = (await mediaConnections(prisma, target.userId)).find( (item) => item.id === choice.credentialId, );" — the connection is found among the caller\'s own',
    reason:
      "The world's model connection offers no media models, so its owner is told the model is not available on it (400).",
  },
  {
    path: "voice/connect",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/calls/voice.ts:147 "if (!isVoiceProviderId(input.provider)) { throw new ORPCError("BAD_REQUEST", { message: "Unknown voice provider." }); } const previous =" — the generated provider is refused for every caller before the model connection is read; resolveVoiceKey then reads it by the caller\'s user id',
    reason:
      "The generated voice provider is not one the catalog knows, so every caller is refused before the model connection is looked up (400).",
  },
  {
    path: "organizations/members/remove",
    kind: "unreached",
    verifiedByCode:
      'packages/db/src/spaces/organization-members.ts:81 "if (input.memberUserId === input.userId) throw new OrganizationAdminRequiredError();" — removing oneself is refused; anyone else goes through requireManager, which reads the caller\'s own role in the organization',
    reason:
      "The only person of the owner's organization the inputs can name is the owner, who cannot remove themselves (403).",
  },
  {
    path: "organizations/members/setRole",
    kind: "unreached",
    verifiedByCode:
      'packages/db/src/spaces/organization-members.ts:81 "if (target === "owner") throw new OrganizationOwnerUnchangeableError();" — reached only after requireManager read the caller\'s own role in the organization',
    reason:
      "The handler found the organization and the caller's role in it; the only person the inputs can name is its owner, whose role cannot change (400).",
  },
  {
    path: "organizations/invitations/accept",
    kind: "reached-409",
    reason:
      'The handler found the invitation, which is to the owner\'s own address; the owner is already a member of the organization it invites to ("They are already a member").',
  },
  {
    path: "pageReviews/grant",
    kind: "reached-409",
    reason:
      'The handler found the page as its owner (reviewAccess); the world\'s page is not shared with specific people, so nobody can be added ("Choose Specific people before adding someone").',
  },
  {
    path: "pageReviews/draft",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/content/page-collaboration.ts:47 "where: { id: pageId, OR: ownerOnly ? [owner] : [owner, reviewWhere(userId)] }," — the page is found only for its owner or a reviewer it was granted to',
    reason:
      "The handler found the owner's page; the request id names no revision draft, as the world has none (404).",
  },
  {
    path: "pageReviews/publish",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/content/page-collaboration.ts:47 "where: { id: pageId, OR: ownerOnly ? [owner] : [owner, reviewWhere(userId)] }," — the page is found only for its owner or a reviewer it was granted to',
    reason:
      "The handler found the owner's page; the request id names no revision draft, as the world has none (404).",
  },
  {
    path: "pageReviews/image",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/content/page-collaboration.ts:47 "where: { id: pageId, OR: ownerOnly ? [owner] : [owner, reviewWhere(userId)] }," — the page is found only for its owner or a reviewer it was granted to',
    reason:
      "The handler found the owner's page; the image id names no picture of that version, as the world's page has none (404).",
  },

  {
    path: "threads/answerToolQuestion",
    kind: "reached-409",
    reason:
      "The handler resolved the chat for the caller (resolveThreadTarget) and looked for the message's question in it; the world's message holds no open question (\"This question is no longer open\").",
  },
  {
    path: "threads/retry",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/routes/threads.ts:371 "retry: authed.threads.retry.handler(async ({ context, input }) => { const { actor } = context; const target = await resolveThreadTarget(deps.prisma, actor, input);" — the chat is resolved for the caller\'s actor first',
    reason:
      "The handler resolved the owner's chat; the world's run did not fail, so it cannot be retried (409), and it is not a run of the extra chat or the group at all (404).",
  },
];
