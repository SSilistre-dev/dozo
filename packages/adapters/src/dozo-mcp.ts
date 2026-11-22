/**
 * The server's MCP endpoint, provider-neutral: the API hands it what one token's owner may do, and
 * it speaks the protocol. The protocol library loads on the first request, so a server nobody
 * connects an MCP client to never loads it.
 */

export type DozoMcpBot = { id: string; name: string; description: string };

/** One of a bot's open extra chats. The bot's main chat is the one reached without a chat. */
export type DozoMcpChat = { id: string; name: string; createdAt: string };

/**
 * How a sent message ended for the caller: the bot answered, is still answering (its chat has the
 * reply later), waits on its person (a question or an approval in the app), or its turn failed.
 */
export type DozoMcpSendResult =
  | { status: "replied"; reply: string; truncated: boolean }
  | { status: "working" | "waiting_for_you" | "failed" };

/** What the token's owner may do. Each one checks access itself; a refusal is a ClientError. */
export type DozoMcpOperations = {
  listBots(): Promise<DozoMcpBot[]>;
  listChats(botId: string): Promise<DozoMcpChat[]>;
  /** Without `chatId` the bot's main chat, as before extra chats. */
  sendMessage(
    botId: string,
    text: string,
    signal: AbortSignal,
    chatId?: string,
  ): Promise<DozoMcpSendResult>;
  readChat(botId: string, chatId?: string): Promise<{ markdown: string }>;
};

export type DozoMcpOptions = {
  /** The server's build, told to clients as the server version. */
  version: string;
};

export async function handleDozoMcpRequest(
  request: Request,
  operations: DozoMcpOperations,
  options: DozoMcpOptions,
): Promise<Response> {
  const { serveDozoMcp } = await import("./dozo-mcp-server.js");
  return serveDozoMcp(request, operations, options);
}

export {
  DOZO_MCP_CHAT_MAX_CHARS,
  DOZO_MCP_MESSAGE_MAX_CHARS,
  DOZO_MCP_REPLY_MAX_CHARS,
} from "./dozo-mcp.tool-definition.js";
