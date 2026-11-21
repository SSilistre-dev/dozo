import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientError } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DozoMcpOperations, DozoMcpOptions } from "./dozo-mcp.js";
import { handleDozoMcpRequest } from "./dozo-mcp.js";
import { DOZO_MCP_MESSAGE_MAX_CHARS, dozoMcpChatUri } from "./dozo-mcp.tool-definition.js";

const ENDPOINT = "http://dozo.test/api/v1/dozo/mcp";
const defaults: DozoMcpOptions = { version: "test" };

const bots = [
  { id: "bot-1", name: "Ada", description: "Writes the weekly report" },
  { id: "bot two", name: "Lin", description: "" },
];

function operations(overrides: Partial<DozoMcpOperations> = {}): DozoMcpOperations {
  return {
    listBots: vi.fn(async () => bots),
    sendMessage: vi.fn(async () => ({
      status: "replied" as const,
      reply: "Done.",
      truncated: false,
    })),
    readChat: vi.fn(async () => ({ markdown: "# Ada\n\n**Ada** · 10:00\n\nHello\n" })),
    ...overrides,
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** A real protocol client whose HTTP requests reach the handler in memory, as the API mounts it. */
async function connect(ops: DozoMcpOperations) {
  const seen: Response[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: async (url, init) => {
      const response = await handleDozoMcpRequest(new Request(url, init), ops, defaults);
      seen.push(response);
      return response;
    },
  });
  const client = new Client({ name: "conformance", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return { client, seen };
}

const json = (result: unknown) => {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]?.text ?? "null");
};

describe("the MCP endpoint, through a real protocol client", () => {
  it("completes the handshake statelessly and offers the bot tools and the chat resource", async () => {
    const { client, seen } = await connect(operations());
    expect(client.getServerVersion()).toMatchObject({ name: "dozo", version: "test" });
    expect(client.getInstructions()).toContain("list_bots");
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });
    // No session is minted, so any API instance answers the next request.
    expect(seen.length).toBeGreaterThan(0);
    for (const response of seen) expect(response.headers.get("mcp-session-id")).toBeNull();

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["list_bots", "send_message"]);
    const send = tools.find((tool) => tool.name === "send_message");
    expect(send?.inputSchema.required).toEqual(["bot_id", "text"]);
    expect(send?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("lists the bots with the address of each chat", async () => {
    const { client } = await connect(operations());
    const result = await client.callTool({ name: "list_bots", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(json(result)).toEqual({
      bots: [
        { ...bots[0], chat: "dozo-chat://bot-1" },
        { ...bots[1], chat: "dozo-chat://bot%20two" },
      ],
    });
  });

  it("sends a message and returns the bot's reply", async () => {
    const ops = operations();
    const { client } = await connect(ops);
    const result = await client.callTool({
      name: "send_message",
      arguments: { bot_id: "bot-1", text: "  Summarise today  " },
    });
    expect(json(result)).toEqual({
      status: "replied",
      reply: "Done.",
      truncated: false,
      chat: dozoMcpChatUri("bot-1"),
    });
    expect(ops.sendMessage).toHaveBeenCalledWith(
      "bot-1",
      "Summarise today",
      expect.any(AbortSignal),
    );
  });

  it("returns at once when the bot waits on its person, with where to read the answer later", async () => {
    const ops = operations({
      sendMessage: vi.fn(async () => ({ status: "waiting_for_you" as const })),
    });
    const { client } = await connect(ops);
    const result = await client.callTool({
      name: "send_message",
      arguments: { bot_id: "bot-1", text: "Pay the invoice" },
    });
    expect(json(result)).toEqual({ status: "waiting_for_you", chat: "dozo-chat://bot-1" });
  });

  it("refuses an empty or oversized message before anything is sent", async () => {
    const ops = operations();
    const { client } = await connect(ops);
    for (const text of ["   ", "x".repeat(DOZO_MCP_MESSAGE_MAX_CHARS + 1)]) {
      const result = await client.callTool({
        name: "send_message",
        arguments: { bot_id: "bot-1", text },
      });
      expect(result.isError).toBe(true);
    }
    expect(ops.sendMessage).not.toHaveBeenCalled();
  });

  it("says a refusal as it is and hides any other failure", async () => {
    const ops = operations({
      listBots: vi.fn(async () => {
        throw new Error("connection string postgres://secret");
      }),
      sendMessage: vi.fn(async () => {
        throw new ClientError("NOT_FOUND", "No such bot.");
      }),
    });
    const { client } = await connect(ops);
    const refused = await client.callTool({
      name: "send_message",
      arguments: { bot_id: "other", text: "hi" },
    });
    expect(refused).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "No such bot." }],
    });
    const failed = await client.callTool({ name: "list_bots", arguments: {} });
    expect(failed).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Something went wrong." }],
    });
  });

  it("lists and reads each bot's chat as a resource", async () => {
    const ops = operations();
    const { client } = await connect(ops);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: "dozo-chat://{bot_id}", mimeType: "text/markdown" }),
    ]);
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([
      "dozo-chat://bot-1",
      "dozo-chat://bot%20two",
    ]);
    const read = await client.readResource({ uri: "dozo-chat://bot%20two" });
    expect(ops.readChat).toHaveBeenCalledWith("bot two");
    expect(read.contents).toEqual([
      {
        uri: "dozo-chat://bot%20two",
        mimeType: "text/markdown",
        text: "# Ada\n\n**Ada** · 10:00\n\nHello\n",
      },
    ]);
  });

  it("answers a refused or failed chat read as a protocol error without the server's message", async () => {
    const ops = operations({
      readChat: vi
        .fn()
        .mockRejectedValueOnce(new ClientError("NOT_FOUND", "No such bot."))
        .mockRejectedValueOnce(new Error("disk /var/lib/secret failed")),
    });
    const { client } = await connect(ops);
    await expect(client.readResource({ uri: "dozo-chat://other" })).rejects.toThrow("No such bot.");
    const failed = client.readResource({ uri: "dozo-chat://bot-1" });
    await expect(failed).rejects.toThrow("Internal error");
    await expect(failed).rejects.not.toThrow("secret");
    await expect(client.readResource({ uri: "dozo-chat://%E0%A4%A" })).rejects.toThrow(
      "Not a chat address.",
    );
    expect(ops.readChat).toHaveBeenCalledTimes(2);
  });

  it("hides a failure to list the chats behind the protocol's own error", async () => {
    const ops = operations({
      listBots: vi.fn(async () => {
        throw new Error("relation bots does not exist");
      }),
    });
    const { client } = await connect(ops);
    const listed = client.listResources();
    await expect(listed).rejects.toThrow("Internal error");
    await expect(listed).rejects.not.toThrow("relation");
  });
});

const post = (body: unknown, version: string) =>
  new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": version,
    },
    body: JSON.stringify(body),
  });

describe("the MCP endpoint over plain HTTP", () => {
  it("answers a tool call that arrives with no handshake, on any instance", async () => {
    const response = await handleDozoMcpRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "list_bots", arguments: {} },
        },
        "2025-11-25",
      ),
      operations(),
      defaults,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text" }] } });
  });

  it("refuses a protocol version it does not speak with a JSON-RPC error, so a newer client falls back", async () => {
    const response = await handleDozoMcpRequest(
      post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "2026-07-28"),
      operations(),
      defaults,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: expect.any(Number) },
    });
  });

  it("allows only POST: no stream to open and no session to end", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await handleDozoMcpRequest(
        new Request(ENDPOINT, { method }),
        operations(),
        defaults,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });
});
