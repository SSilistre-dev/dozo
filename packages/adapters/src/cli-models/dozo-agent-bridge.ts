import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ConnectorTool } from "@rakazo/adapter-kit";

/**
 * The bridge from an agent to Dozo's own tools. The agent starts a small stdio MCP server (the
 * script below) that only relays: tool lists and calls go over a socket in a folder only the
 * server's user can open, with a key made for this run, to the process running the run, which
 * calls its own tool executor. The key and the socket end with the bridge.
 */
const BRIDGE_SCRIPT = `import { connect } from "node:net";
import { createInterface } from "node:readline";
const socket = connect(process.env.DOZO_BRIDGE_SOCKET);
const key = process.env.DOZO_BRIDGE_KEY;
const waiting = new Map();
let next = 0;
const ask = (message) => new Promise((resolve) => {
  const id = ++next;
  waiting.set(id, resolve);
  socket.write(JSON.stringify({ ...message, id, key }) + "\\n");
});
createInterface({ input: socket }).on("line", (line) => {
  let reply;
  try { reply = JSON.parse(line); } catch { return; }
  waiting.get(reply.id)?.(reply);
  waiting.delete(reply.id);
});
socket.on("close", () => process.exit(0));
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (!request || typeof request !== "object" || request.id === undefined) continue;
  const { id, method, params } = request;
  if (method === "initialize") {
    send({ id, result: {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "dozo", version: "1" },
    } });
  } else if (method === "tools/list") {
    const reply = await ask({ method: "list" });
    send({ id, result: { tools: reply.tools ?? [] } });
  } else if (method === "tools/call") {
    const reply = await ask({ method: "call", name: params?.name, arguments: params?.arguments ?? {} });
    send({ id, result: { content: [{ type: "text", text: String(reply.text ?? "") }], isError: Boolean(reply.isError) } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

export type BridgeCall = (
  name: string,
  args: Record<string, unknown>,
  callId: string,
) => Promise<{ text: string; isError: boolean }>;

export interface AgentBridge {
  /** How the agent starts the bridge's MCP server. */
  launch: { command: string; args: string[]; env: Record<string, string> };
  /** The tools the current attempt offers and the executor that runs them. */
  serve(tools: readonly ConnectorTool[], call: BridgeCall | undefined): void;
  /** Whether the agent has listed the tools: the bridge is connected. */
  listed(): boolean;
  close(): Promise<void>;
}

const MAX_LINE = 4 * 1024 * 1024;

export async function startAgentBridge(): Promise<AgentBridge> {
  const folder = await mkdtemp(join(tmpdir(), "dozo-bridge-"));
  const socketPath = join(folder, "s");
  const script = join(folder, "bridge.mjs");
  await writeFile(script, BRIDGE_SCRIPT, { mode: 0o600 });
  const key = randomBytes(32);
  let tools: readonly ConnectorTool[] = [];
  let call: BridgeCall | undefined;
  let calls = 0;
  let wasListed = false;
  const sockets = new Set<Socket>();
  const keyMatches = (value: unknown) => {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return false;
    return timingSafeEqual(Buffer.from(value, "hex"), key);
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    // Bytes since the last line break: a line longer than the limit ends the connection.
    let unbroken = 0;
    socket.on("data", (chunk: Buffer) => {
      const lastBreak = chunk.lastIndexOf(10);
      unbroken = lastBreak === -1 ? unbroken + chunk.length : chunk.length - lastBreak - 1;
      if (unbroken > MAX_LINE) socket.destroy();
    });
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", async (line) => {
      let message: {
        id?: unknown;
        key?: unknown;
        method?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      try {
        message = JSON.parse(line);
      } catch {
        return socket.destroy();
      }
      // Anything without this run's key ends the connection.
      if (!keyMatches(message.key)) return socket.destroy();
      const reply = (body: Record<string, unknown>) =>
        socket.write(`${JSON.stringify({ id: message.id, ...body })}\n`);
      if (message.method === "list") {
        wasListed = true;
        reply({
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
      } else if (message.method === "call") {
        const name = typeof message.name === "string" ? message.name : "";
        const args =
          message.arguments &&
          typeof message.arguments === "object" &&
          !Array.isArray(message.arguments)
            ? (message.arguments as Record<string, unknown>)
            : {};
        if (!call || !tools.some((tool) => tool.name === name))
          return reply({ text: `There is no tool named ${name}.`, isError: true });
        calls += 1;
        try {
          reply(await call(name, args, `bridge-${calls}`));
        } catch (error) {
          reply({ text: error instanceof Error ? error.message : String(error), isError: true });
        }
      } else {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    launch: {
      command: process.execPath,
      args: [script],
      env: { DOZO_BRIDGE_SOCKET: socketPath, DOZO_BRIDGE_KEY: key.toString("hex") },
    },
    serve(nextTools, nextCall) {
      tools = nextTools;
      call = nextCall;
    },
    listed: () => wasListed,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    },
  };
}
