import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RpcMessage } from "./dozo-agent-rpc.js";
import { AgentProcess, agentEnv, EXITED, RpcError } from "./dozo-agent-rpc.js";

/** A tiny JSON-RPC peer: it prints junk, answers by method, and exits on "bye". */
const PEER = `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
process.stdout.write("not json\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "fail") send({ id, error: { code: -32001 } });
  else if (method === "echo") send({ id, result: params });
  else if (method === "note") send({ method: "noted", params });
  else if (method === "bye") process.exit(0);
}
`;

function peer() {
  const folder = mkdtempSync(join(tmpdir(), "dozo-rpc-"));
  writeFileSync(join(folder, "peer.mjs"), PEER);
  return AgentProcess.start(
    "Peer",
    process.execPath,
    [join(folder, "peer.mjs")],
    { home: folder },
    folder,
  );
}

describe.skipIf(process.platform === "win32")("an agent's JSON-RPC process", () => {
  it("answers requests and passes the agent's own messages on", async () => {
    const agent = peer();
    const seen: RpcMessage[] = [];
    agent.on((message) => seen.push(message));
    expect(await agent.request("echo", { a: 1 })).toEqual({ a: 1 });
    agent.notify("note", { b: 2 });
    agent.notify("note");
    await expect(agent.request("fail", {})).rejects.toEqual(new RpcError("Peer refused.", -32001));
    expect(seen).toContainEqual({ jsonrpc: "2.0", method: "noted", params: { b: 2 } });
    agent.close();
    agent.close();
  });

  it("gives up on an answer that does not come, and refuses once the process is gone", async () => {
    const agent = peer();
    await expect(agent.request("silent", {}, 100)).rejects.toThrow("Peer did not answer silent.");
    const gone = new Promise<void>((resolve) =>
      agent.on((message) => {
        if (message.method === EXITED) resolve();
      }),
    );
    const pendingForever = agent.request("silent", {}, null);
    agent.notify("bye");
    await gone;
    await expect(pendingForever).rejects.toThrow("Peer stopped.");
    await expect(agent.request("echo", {})).rejects.toThrow("Peer stopped.");
    agent.respond(1, { result: {} });
  });

  it("gives an agent the person's home and PATH, and nothing of the server's", () => {
    const env = agentEnv({ home: "/home/ada" });
    expect(env.HOME).toBe("/home/ada");
    expect(env.PATH).toBe(process.env.PATH);
    expect(agentEnv({ home: "/home/ada", path: "/opt/bin" }).PATH).toBe("/opt/bin");
  });
});
