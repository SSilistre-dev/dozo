// A deterministic OpenAI-compatible model server for the e2e suite: no dependencies, Node only.
// GET /v1/models lists one model; POST /v1/chat/completions answers every request with one canned
// reply (streamed when the caller asks for a stream). It never calls anything and never checks a
// key, so no real model or API key is involved. Run by e2e/run.sh in a throwaway container on the
// stack's network, so the api and worker containers can reach it as an owner-run local server.
// Tool calls: when the newest user message holds `[e2e-tool:<name> <args>]` and the request
// offers a tool of that name, the answer is that one tool call; once the newest message is the
// tool's result, the answer is TOOL_DONE. A tool the request does not offer is said so in text.
// `[e2e-table]` asks for a reply that is a markdown table (TABLE).
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = "dozo-e2e-model";
const REPLY = "Hello from the offline Dozo test model.";
export const TOOL_DONE = "The offline test model saw the tool finish.";
// `[e2e-table]` in the newest user message: a reply with a markdown table, for the look spec.
export const TABLE = "| Topic | Open |\n| --- | --- |\n| Billing | 3 |\n| Export | 2 |";
// Arguments as JSON, or as `b64:<base64 JSON>` so the message does not name what they hold (a
// site the owner names in their own words counts as one they asked for, and is not asked about).
const TOOL_ASK = /\[e2e-tool:([a-z_]+)(?:\s+(\{[^\]]*\}|b64:[A-Za-z0-9+/=]+))?\]/;
let completions = 0;

/** The text of a chat message, whose content is a string or a list of parts. */
function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join(" ");
  return "";
}

/**
 * What to answer a completion request: `{ text }` or `{ tool: { name, arguments } }` (see the header).
 * Exported for the stub's own test.
 */
export function plan(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const newest = messages.at(-1);
  if (newest?.role === "tool") return { text: TOOL_DONE };
  const user = [...messages].reverse().find((message) => message?.role === "user");
  const ask = TOOL_ASK.exec(textOf(user));
  if (!ask) return { text: textOf(user).includes("[e2e-table]") ? TABLE : REPLY };
  const [, name, raw = "{}"] = ask;
  const args = raw.startsWith("b64:") ? Buffer.from(raw.slice(4), "base64").toString("utf8") : raw;
  const names = (Array.isArray(body?.tools) ? body.tools : []).map(
    (tool) => tool?.function?.name ?? tool?.name,
  );
  return names.includes(name)
    ? { tool: { name, arguments: args } }
    : { text: `The tool ${name} is not offered. Offered: ${names.join(", ") || "none"}.` };
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(""));
  });
}

const server = createServer(async (request, response) => {
  const path = (request.url ?? "").split("?")[0];
  if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
    return;
  }
  if (request.method === "GET" && path === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, completions }));
    return;
  }
  if (request.method === "POST" && path.endsWith("/chat/completions")) {
    let body = {};
    try {
      body = JSON.parse(await readBody(request));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "body is not JSON" } }));
      return;
    }
    completions += 1;
    const answer = plan(body);
    const id = `chatcmpl-e2e-${completions}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 };
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model: MODEL,
          choices: [
            answer.tool
              ? {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: `call-${id}`, type: "function", function: answer.tool }],
                  },
                  finish_reason: "tool_calls",
                }
              : {
                  index: 0,
                  message: { role: "assistant", content: answer.text },
                  finish_reason: "stop",
                },
          ],
          usage,
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta, finish = null, extra = {}) =>
      response.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
      );
    chunk({ role: "assistant" });
    if (answer.tool) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call-${id}`,
            type: "function",
            function: { name: answer.tool.name, arguments: "" },
          },
        ],
      });
      chunk({ tool_calls: [{ index: 0, function: { arguments: answer.tool.arguments } }] });
      chunk({}, "tool_calls", { usage });
    } else {
      for (const word of answer.text.split(" ")) chunk({ content: `${word} ` });
      chunk({}, "stop", { usage });
    }
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "not found" } }));
});
if (import.meta.url === `file://${process.argv[1]}`)
  server.listen(PORT, "0.0.0.0", () => console.log(`model stub on :${PORT}`));
