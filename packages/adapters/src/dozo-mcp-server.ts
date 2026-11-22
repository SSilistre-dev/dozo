import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ClientError } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { DozoMcpOperations, DozoMcpOptions } from "./dozo-mcp.js";
import {
  DOZO_MCP_CHAT_URI_TEMPLATE,
  DOZO_MCP_EXTRA_CHAT_URI_TEMPLATE,
  DOZO_MCP_INSTRUCTIONS,
  dozoMcpChatUri,
  dozoMcpTools,
} from "./dozo-mcp.tool-definition.js";

/**
 * Answers one MCP request with a server of its own, in the transport's stateless JSON mode: no
 * session is kept between requests, so any API instance answers any of them.
 */
export async function serveDozoMcp(
  request: Request,
  operations: DozoMcpOperations,
  options: DozoMcpOptions,
): Promise<Response> {
  // No session is kept and nothing is pushed, so a client only ever posts a message.
  if (request.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
      { status: 405, headers: { Allow: "POST" } },
    );
  }
  const server = new McpServer(
    { name: "dozo", version: options.version },
    { instructions: DOZO_MCP_INSTRUCTIONS },
  );
  server.registerTool(
    dozoMcpTools.listBots.name,
    {
      description: dozoMcpTools.listBots.description,
      inputSchema: dozoMcpTools.listBots.inputSchema,
      annotations: { readOnlyHint: true },
    },
    () =>
      answer(async () => {
        const bots = await operations.listBots();
        return { bots: bots.map((bot) => ({ ...bot, chat: dozoMcpChatUri(bot.id) })) };
      }),
  );
  server.registerTool(
    dozoMcpTools.listChats.name,
    {
      description: dozoMcpTools.listChats.description,
      inputSchema: dozoMcpTools.listChats.inputSchema,
      annotations: { readOnlyHint: true },
    },
    ({ bot_id }) =>
      answer(async () => {
        const chats = await operations.listChats(bot_id);
        return { chats: chats.map((chat) => ({ ...chat, chat: dozoMcpChatUri(bot_id, chat.id) })) };
      }),
  );
  server.registerTool(
    dozoMcpTools.sendMessage.name,
    {
      description: dozoMcpTools.sendMessage.description,
      inputSchema: dozoMcpTools.sendMessage.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ bot_id, text, chat_id }, extra) =>
      answer(async () => ({
        ...(await (chat_id === undefined
          ? operations.sendMessage(bot_id, text, extra.signal)
          : operations.sendMessage(bot_id, text, extra.signal, chat_id))),
        chat: dozoMcpChatUri(bot_id, chat_id),
      })),
  );
  server.registerResource(
    dozoMcpTools.chat.name,
    new ResourceTemplate(DOZO_MCP_CHAT_URI_TEMPLATE, {
      list: () =>
        protocolAnswer(async () => ({
          resources: (await operations.listBots()).map((bot) => ({
            uri: dozoMcpChatUri(bot.id),
            name: bot.name,
            mimeType: "text/markdown",
          })),
        })),
    }),
    { description: dozoMcpTools.chat.description, mimeType: "text/markdown" },
    (uri, { bot_id }) =>
      protocolAnswer(async () => {
        const chat = await operations.readChat(uriPart(String(bot_id)));
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: chat.markdown }] };
      }),
  );
  // Listed by list_chats, not here: listing them would read every bot's chats on each request.
  server.registerResource(
    dozoMcpTools.extraChat.name,
    new ResourceTemplate(DOZO_MCP_EXTRA_CHAT_URI_TEMPLATE, { list: undefined }),
    { description: dozoMcpTools.extraChat.description, mimeType: "text/markdown" },
    (uri, { bot_id, chat_id }) =>
      protocolAnswer(async () => {
        const chat = await operations.readChat(uriPart(String(bot_id)), uriPart(String(chat_id)));
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: chat.markdown }] };
      }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

/**
 * A tool's answer as JSON text. A refusal the caller can act on is said as it is; any other failure
 * is logged here and the client hears only that it failed, never the server's own message.
 */
async function answer(work: () => Promise<object>) {
  try {
    const result = await work();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    if (!(error instanceof ClientError)) getLogger().error("dozo mcp tool failed", error);
    const text = error instanceof ClientError ? error.message : "Something went wrong.";
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

function uriPart(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new ClientError("BAD_REQUEST", "Not a chat address.");
  }
}

/** The same rule for a resource, answered as a protocol error rather than a tool result. */
async function protocolAnswer<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ClientError) throw new McpError(ErrorCode.InvalidParams, error.message);
    getLogger().error("dozo mcp resource failed", error);
    throw new McpError(ErrorCode.InternalError, "Internal error");
  }
}
