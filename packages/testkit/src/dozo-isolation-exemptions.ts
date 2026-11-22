/**
 * Procedures the isolation matrix does not call, each with the reason. `input`: the generator
 * cannot build a valid input for it, so it is not swept (the matrix fails once it can, so a stale
 * entry is removed). `side-effect`: calling it would break the test world for the caller itself;
 * allowed only for a procedure that names no target (the matrix fails if its input carries an id).
 * `unreached`: still swept, but the owner's own call with the same input does not get through
 * (feature off in tests, needs an outside provider, refused by design), so a foreign caller's
 * refusal of it proves nothing; the matrix fails once the owner gets through.
 */
export type IsolationExemption = {
  path: string;
  kind: "input" | "side-effect" | "unreached";
  /** For `unreached`: the one generated input it covers, by its label; every one when left out. */
  variant?: string;
  reason: string;
};

export const ISOLATION_EXEMPTIONS: readonly IsolationExemption[] = [
  {
    path: "models/connect",
    kind: "input",
    reason:
      "Its refinement compares token limits with each other (output must leave room for input), which a field-by-field generator cannot satisfy; it names no Space, bot or chat, only the caller's own model connection.",
  },
  {
    path: "security/events",
    kind: "unreached",
    reason: "Answers FORBIDDEN to every app account (403); it has no handler that reads its input.",
  },
  {
    path: "dozoAdmin/user",
    kind: "unreached",
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/rename",
    kind: "unreached",
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/setPlan",
    kind: "unreached",
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/endSessions",
    kind: "unreached",
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/setSuspended",
    kind: "unreached",
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/deleteUser",
    kind: "unreached",
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "dozoAdmin/ban",
    kind: "unreached",
    variant: "option 0",
    reason:
      "A server admin's procedure: no person in the world is a server admin, so the owner is refused at the admin check too (403), before the account is looked up.",
  },
  {
    path: "computer/readFile",
    kind: "unreached",
    reason:
      "Names a file in the bot's home; the world's bot has none, and a missing file answers its owner 500, not 404.",
  },
  {
    path: "computer/downloadFile",
    kind: "unreached",
    reason:
      "Names a file on the bot's computer; the world's bot has none, and a missing file answers its owner 500, not 404.",
  },
  {
    path: "artifacts/get",
    kind: "unreached",
    variant: "groupId",
    reason:
      "P's artifact belongs to the bot's own chat, so named through the group it is not found for its owner either (404); the botId input reaches it.",
  },
  {
    path: "artifacts/get",
    kind: "unreached",
    variant: "chatBotId+chatId",
    reason:
      "Refused by design before any lookup (400 dozo_extra_chat_not_a_target): an extra chat is not a target here.",
  },
  {
    path: "artifacts/create",
    kind: "unreached",
    variant: "chatBotId+chatId",
    reason:
      "Refused by design before any lookup (400 dozo_extra_chat_not_a_target): an extra chat is not a target here.",
  },
  {
    path: "botSections/create",
    kind: "unreached",
    variant: "chatBotId+chatId",
    reason:
      "Refused by design before any lookup (400 dozo_extra_chat_not_a_target): an extra chat is not a target here.",
  },
  {
    path: "threads/clear",
    kind: "unreached",
    variant: "chatBotId+chatId",
    reason:
      "Refused by design before any lookup (400 dozo_extra_chat_unsupported): clearing works in a bot's main chat only.",
  },
  {
    path: "threads/react",
    kind: "unreached",
    variant: "groupId",
    reason:
      "P's messages live in the bot's chats, none in the group's, so the message is not found for its owner either (404); the botId and chat inputs reach it.",
  },
  {
    path: "threads/markUnread",
    kind: "unreached",
    variant: "groupId+messageId",
    reason:
      "P's messages live in the bot's chats, none in the group's, so the message is not found for its owner either (404); the botId input reaches it.",
  },
  {
    path: "threads/answerCall",
    kind: "unreached",
    reason:
      "Names a voice call; none exists, as calls come from a voice provider the tests do not run (404).",
  },
  {
    path: "threads/endCall",
    kind: "unreached",
    reason:
      "Names a voice call; none exists, as calls come from a voice provider the tests do not run (404).",
  },
  {
    path: "threads/declineCall",
    kind: "unreached",
    reason:
      "Names a voice call; none exists, as calls come from a voice provider the tests do not run (404).",
  },
  {
    path: "organizations/rename",
    kind: "unreached",
    reason:
      "Only an organization whose other members are all guests can be renamed; A's has C as a member by design of the world, so its owner is refused as not found too (404).",
  },
  {
    path: "organizations/remove",
    kind: "unreached",
    reason:
      "An organization with other members cannot be deleted; A's has C as a member by design of the world (400).",
  },
  {
    path: "spaces/remove",
    kind: "unreached",
    reason: "P is A's default Space, which cannot be deleted (400).",
  },
  {
    path: "spaces/members/remove",
    kind: "unreached",
    reason: "P's only member is A, its owner, who cannot be removed (400).",
  },
  {
    path: "spaces/members/leave",
    kind: "unreached",
    reason: "A owns P, and an owner cannot leave (400).",
  },
  {
    path: "bots/create",
    kind: "unreached",
    reason:
      "Its id is the new bot's own; P's bot id is taken, so the owner's create fails on the unique id too (answers 500, not 409).",
  },
  {
    path: "bots/claimEmailAddress",
    kind: "unreached",
    reason:
      "The test server receives no email, so every caller is refused before the bot is looked up (400).",
  },
  {
    path: "mcp/servers/agents",
    kind: "unreached",
    reason:
      "Names a connected tool server; the world connects none, as one needs an outside server (404).",
  },
  {
    path: "mcp/assignments/approve",
    kind: "unreached",
    reason:
      "Names a connected tool server; the world connects none, as one needs an outside server (404).",
  },
  {
    path: "messaging/installations/start",
    kind: "unreached",
    reason:
      "No messaging app installation provider is configured in tests, so every caller is refused before the bot is looked up (400).",
  },
  {
    path: "messaging/identities/setBot",
    kind: "unreached",
    reason: "Names a messaging app identity; none exists without a messaging app (404).",
  },
  {
    path: "dozoQueue/cancelWaiting",
    kind: "unreached",
    variant: "option 0",
    reason:
      "The run the seed queues has been picked up and completed before the owner's control runs, so nothing of P's is waiting (404).",
  },
  {
    path: "dozoQueue/cancelWaiting",
    kind: "unreached",
    variant: "option 1",
    reason:
      "Names P's first message, which was answered at once and never waited in a queue (404).",
  },
  {
    path: "memory/remove",
    kind: "unreached",
    reason:
      "P's memory is the bot's MEMORY.md, which cannot be deleted (400), and no procedure makes another memory document.",
  },
];
