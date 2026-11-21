// A stand-in for `codex` (0.171 app-server protocol) for offline tests of agent mode. It starts the
// MCP server it is given like Codex does, and answers turns by scenario.
// Usage: node dozo-fake-app-server.test-support.mjs <scenario> <log> ...codex args
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [scenario, logPath, ...args] = process.argv.slice(2);
const log = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

if (args[0] === "--version") {
  const versions = { old: "codex-cli 0.170.2\n", garbled: "codex-cli dev\n" };
  process.stdout.write(versions[scenario] ?? "codex-cli 0.171.3\n");
  process.exit(0);
}

log({ started: args, env: process.env, cwd: process.cwd() });
let mcp;
let mcpNext = 100;
const mcpWaiting = new Map();
const mcpAsk = (method, params) =>
  new Promise((resolve) => {
    const id = ++mcpNext;
    mcpWaiting.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

/** Starts the MCP server the way Codex does: initialize, then list its tools. */
async function startMcp(config) {
  const server = config?.mcp_servers?.dozo;
  send({ method: "mcpServer/startupStatus/updated", params: { name: "dozo", status: "starting" } });
  if (scenario === "bridge-fails" || !server) {
    send({ method: "mcpServer/startupStatus/updated", params: { name: "dozo", status: "failed" } });
    return;
  }
  mcp = spawn(server.command, server.args, {
    env: { ...server.env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  createInterface({ input: mcp.stdout }).on("line", (line) => {
    const reply = JSON.parse(line);
    mcpWaiting.get(reply.id)?.(reply);
  });
  await mcpAsk("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "codex-mcp-client" },
  });
  const listed = await mcpAsk("tools/list", {});
  log({ mcpTools: listed.result.tools.map((tool) => tool.name) });
  send({ method: "mcpServer/startupStatus/updated", params: { name: "dozo", status: "ready" } });
}

let turn = 0;
let currentTurn;
const pending = new Map();
let serverRequest = 900;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++serverRequest;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const delta = (text) =>
  send({
    method: "item/agentMessage/delta",
    params: { delta: text, itemId: "i", threadId: "t-1", turnId: currentTurn },
  });
const complete = (status, error) =>
  send({
    method: "turn/completed",
    params: {
      threadId: "t-1",
      turn: { id: currentTurn, items: [], status, ...(error ? { error } : {}) },
    },
  });
let interrupted;
let wasInterrupted = false;
const untilInterrupted = () =>
  wasInterrupted ? Promise.resolve() : new Promise((resolve) => (interrupted = resolve));

async function runTurn(input) {
  const text = input[0]?.text ?? "";
  if (scenario === "reply") {
    delta("Hello ");
    delta("there");
    return complete("completed");
  }
  if (scenario === "command") {
    send({
      method: "item/started",
      params: { item: { type: "commandExecution", command: "ls -la", id: "c1" } },
    });
    const answer = await ask("item/commandExecution/requestApproval", {
      threadId: "t-1",
      turnId: currentTurn,
      itemId: "c1",
      command: "ls -la",
      cwd: "/work",
      reason: "to look around",
    });
    log({ decision: answer.result ?? answer.error });
    delta(`decision ${JSON.stringify(answer.result?.decision)}`);
    return complete("completed");
  }
  if (scenario === "permissions") {
    const answer = await ask("item/permissions/requestApproval", {
      threadId: "t-1",
      turnId: currentTurn,
      itemId: "p1",
      cwd: "/work",
      startedAtMs: 1,
      permissions: { network: { enabled: true } },
    });
    log({ decision: answer.result });
    return complete("completed");
  }
  if (scenario === "tool") {
    if (text.startsWith("continue:")) {
      delta("after approval");
      return complete("completed");
    }
    const called = await mcpAsk("tools/call", { name: "lookup", arguments: { city: "Oslo" } });
    const result = called.result.content[0].text;
    delta(`tool said ${result}`);
    if (result.startsWith("Waiting for the person's approval")) {
      await untilInterrupted();
      return complete("interrupted");
    }
    return complete("completed");
  }
  if (scenario === "limit") {
    const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
    send({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          rateLimitReachedType: "rateLimitReached",
          primary: { usedPercent: 100, resetsAt },
        },
      },
    });
    const error = { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" };
    send({
      method: "error",
      params: { error, threadId: "t-1", turnId: currentTurn, willRetry: false },
    });
    return complete("failed", error);
  }
  if (scenario === "unauthorized") {
    const error = {
      message: "unexpected status 401",
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
    };
    send({
      method: "error",
      params: { error, threadId: "t-1", turnId: currentTurn, willRetry: true },
    });
    await untilInterrupted();
    return complete("interrupted");
  }
  if (scenario === "unknown-request") {
    const answer = await ask("item/tool/requestUserInput", {
      threadId: "t-1",
      turnId: currentTurn,
      questions: [],
    });
    log({ unknownAnswer: answer });
    delta("ok");
    return complete("completed");
  }
  if (scenario === "file-change") {
    send({ method: "item/started", params: { item: { type: "fileChange", id: "f0" } } });
    send({
      method: "item/started",
      params: { item: { type: "fileChange", id: "f1", changes: [{ path: "notes.md" }, {}] } },
    });
    send({ method: "item/started", params: { item: { type: "reasoning", id: "r1" } } });
    const answer = await ask("item/fileChange/requestApproval", {
      threadId: "t-1",
      turnId: currentTurn,
      itemId: "f1",
      startedAtMs: 1,
      reason: "edit the notes",
    });
    log({ decision: answer.result });
    return complete("completed");
  }
  if (scenario === "elicit") {
    const answer = await ask("mcpServer/elicitation/request", { message: "Go on with lookup?" });
    log({ decision: answer.result });
    return complete("completed");
  }
  if (scenario === "crash") {
    delta("partial");
    process.exit(3);
  }
  if (scenario === "fail") {
    send({
      method: "error",
      params: { error: { message: "busy" }, threadId: "t-1", turnId: currentTurn, willRetry: true },
    });
    send({
      method: "error",
      params: {
        error: { message: "model went away" },
        threadId: "t-1",
        turnId: currentTurn,
        willRetry: false,
      },
    });
    return complete("failed");
  }
  if (scenario === "limit-unknown") {
    const error = { message: "limit", codexErrorInfo: "usageLimitExceeded" };
    send({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 40 } } },
    });
    send({
      method: "account/rateLimits/updated",
      params: { rateLimits: { rateLimitReachedType: "x", primary: { usedPercent: 100 } } },
    });
    send({
      method: "error",
      params: { error, threadId: "t-1", turnId: currentTurn, willRetry: false },
    });
    return complete("failed", error);
  }
  if (scenario === "turn-failed") return complete("failed");
  if (scenario === "turn-missing")
    return send({ method: "turn/completed", params: { threadId: "t-1" } });
  if (scenario === "fail-silent") {
    return send({
      method: "error",
      params: { threadId: "t-1", turnId: currentTurn, willRetry: false },
    });
  }
  if (scenario === "turn-error") return complete("failed", { message: "bad things" });
  if (scenario === "hang") {
    delta("working");
    await untilInterrupted();
    return complete("interrupted");
  }
  return complete("failed", { message: "unknown scenario" });
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
    send({
      id,
      result: {
        userAgent: "codex_cli_rs/0.171.3",
        codexHome: "/home/x/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
  } else if (method === "initialized") {
    // A notification.
  } else if (method === "account/read") {
    send({
      id,
      result:
        scenario === "signed-out"
          ? { account: null, requiresOpenaiAuth: true }
          : {
              account: { type: "chatgpt", email: "someone@example.com", planType: "plus" },
              requiresOpenaiAuth: true,
            },
    });
  } else if (method === "thread/start") {
    if (scenario === "dead-at-thread") process.exit(4);
    await startMcp(params.config);
    send({
      id,
      result: {
        thread: { id: "t-1" },
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
        cwd: params.cwd,
        model: "m",
        modelProvider: "openai",
        sandbox: { type: "workspaceWrite" },
      },
    });
  } else if (method === "turn/start" && scenario === "turn-refused") {
    send({ id, error: { code: -32600, message: "Codex refused the turn." } });
  } else if (method === "turn/start") {
    turn += 1;
    currentTurn = `turn-${turn}`;
    wasInterrupted = false;
    send({ id, result: { turn: { id: currentTurn, items: [], status: "inProgress" } } });
    void runTurn(params.input);
  } else if (method === "turn/interrupt") {
    send({ id, result: {} });
    wasInterrupted = true;
    interrupted?.();
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
