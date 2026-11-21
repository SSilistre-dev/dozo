// A stand-in for an ACP agent (protocol version 1) for offline tests of agent mode. It starts the
// MCP server it is given like an ACP agent does, and answers prompts by scenario.
// Usage: node dozo-fake-acp-agent.test-support.mjs <scenario> <log> ...agent args
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [scenario, logPath, ...args] = process.argv.slice(2);
const log = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
log({ started: args, env: process.env });

let mcp;
let mcpNext = 100;
const mcpWaiting = new Map();
const mcpAsk = (method, params) =>
  new Promise((resolve) => {
    const id = ++mcpNext;
    mcpWaiting.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

async function startMcp(server) {
  const env = Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value]));
  mcp = spawn(server.command, server.args, { env, stdio: ["pipe", "pipe", "ignore"] });
  createInterface({ input: mcp.stdout }).on("line", (line) => {
    const reply = JSON.parse(line);
    mcpWaiting.get(reply.id)?.(reply);
  });
  await mcpAsk("initialize", { protocolVersion: "2025-06-18" });
  const listed = await mcpAsk("tools/list", {});
  log({ mcpTools: listed.result.tools.map((tool) => tool.name) });
}

const pending = new Map();
let next = 900;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++next;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const chunk = (text) =>
  send({
    method: "session/update",
    params: {
      sessionId: "s-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
let cancelled;
let wasCancelled = false;
const untilCancelled = () =>
  wasCancelled ? Promise.resolve() : new Promise((resolve) => (cancelled = resolve));
const permission = (options) =>
  ask("session/request_permission", {
    sessionId: "s-1",
    toolCall: {
      toolCallId: "c1",
      title: "Run ls",
      kind: "execute",
      locations: [{ path: "/w/a" }],
      rawInput: { command: "ls" },
    },
    options,
  });
const ALL = [
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "once", name: "Allow", kind: "allow_once" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
  { optionId: "never", name: "Always reject", kind: "reject_always" },
];

async function prompt(id, params) {
  wasCancelled = false;
  const text = params.prompt?.[0]?.text ?? "";
  log({ prompt: text });
  const end = (stopReason) => send({ id, result: { stopReason } });
  if (scenario === "reply") {
    send({
      method: "session/update",
      params: {
        sessionId: "other",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "not ours" },
        },
      },
    });
    send({
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Reading notes" },
      },
    });
    send({
      method: "session/update",
      params: { sessionId: "s-1", update: { sessionUpdate: "plan", entries: [] } },
    });
    chunk("Hello ");
    chunk("there");
    return end("end_turn");
  }
  if (scenario === "permission" || scenario === "permission-no-once") {
    const answer = await permission(scenario === "permission" ? ALL : [ALL[0], ALL[3]]);
    log({ outcome: answer.result.outcome });
    chunk(`outcome ${JSON.stringify(answer.result.outcome)}`);
    return end("end_turn");
  }
  if (scenario === "stray-permissions") {
    // One of another session, then the same id twice: only the first of this session counts.
    const other = new Promise((resolve) => pending.set(700, resolve));
    send({
      id: 700,
      method: "session/request_permission",
      params: { sessionId: "other", toolCall: {}, options: ALL },
    });
    log({ otherOutcome: (await other).result.outcome });
    const first = new Promise((resolve) => pending.set(777, resolve));
    send({
      id: 777,
      method: "session/request_permission",
      params: { sessionId: "s-1", toolCall: { title: "a" }, options: ALL },
    });
    send({
      id: 777,
      method: "session/request_permission",
      params: { sessionId: "s-1", toolCall: { title: "b" }, options: ALL },
    });
    log({ outcome: (await first).result.outcome });
    log({ outcome: (await new Promise((resolve) => pending.set(777, resolve))).result.outcome });
    return end("end_turn");
  }
  if (scenario === "cancel-pending") {
    const answered = permission(ALL);
    await untilCancelled();
    log({ outcome: (await answered).result.outcome });
    return end("cancelled");
  }
  if (scenario === "tool") {
    if (text.startsWith("continue:")) {
      chunk("after approval");
      return end("end_turn");
    }
    const called = await mcpAsk("tools/call", { name: "lookup", arguments: { city: "Oslo" } });
    const result = called.result.content[0].text;
    chunk(`tool said ${result}`);
    if (result.startsWith("Waiting for the person's approval")) {
      await untilCancelled();
      return end("cancelled");
    }
    return end("end_turn");
  }
  if (scenario === "fs-request") {
    const answer = await ask("fs/read_text_file", { sessionId: "s-1", path: "/etc/passwd" });
    log({ fsAnswer: answer });
    chunk("ok");
    return end("end_turn");
  }
  if (scenario === "hang") {
    chunk("working");
    await untilCancelled();
    return end("cancelled");
  }
  if (scenario === "refusal") return end("refusal");
  if (scenario === "odd") return end("something_new");
  if (scenario === "error")
    return send({ id, error: { code: -32603, message: "Quota exceeded for this account." } });
  if (scenario === "crash") {
    chunk("partial");
    process.exit(3);
  }
  return end("end_turn");
}

function initReply(id) {
  send({
    id,
    result: {
      protocolVersion: scenario === "v2" ? 2 : 1,
      agentInfo: { name: "fake", version: scenario === "old" ? "1.4.9" : "1.5.13" },
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: scenario === "cached" ? "cached_token" : "oauth-personal" }],
    },
  });
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  log({ received: message });
  if (message.method === undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    continue;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    if (scenario === "dead") process.exit(5);
    if (scenario === "early-request") {
      // Asked before any turn: it must be answered, not left hanging.
      void (async () => {
        const early = new Promise((resolve) => pending.set(555, resolve));
        send({
          id: 555,
          method: "fs/read_text_file",
          params: { sessionId: "s-1", path: "/etc/hosts" },
        });
        const permission = new Promise((resolve) => pending.set(556, resolve));
        send({
          id: 556,
          method: "session/request_permission",
          params: { sessionId: "s-1", toolCall: {}, options: ALL },
        });
        log({ earlyAnswer: await early, earlyPermission: (await permission).result });
        initReply(id);
      })();
      continue;
    }
    initReply(id);
  } else if (method === "authenticate") {
    send({ id, result: {} });
  } else if (method === "session/new") {
    if (scenario === "signed-out") {
      send({ id, error: { code: -32000, message: "Authentication required" } });
      continue;
    }
    if (scenario === "session-broken") {
      send({ id, error: { code: -32603, message: "internal" } });
      continue;
    }
    if (scenario !== "bridge-silent") await startMcp(params.mcpServers[0]);
    send({ id, result: { sessionId: "s-1" } });
  } else if (method === "session/prompt") {
    void prompt(id, params);
  } else if (method === "session/cancel") {
    wasCancelled = true;
    cancelled?.();
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
