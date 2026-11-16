// A deterministic OpenAI-compatible model server for the e2e suite: no dependencies, Node only.
// GET /v1/models lists one model; POST /v1/chat/completions answers every request with one canned
// reply (streamed when the caller asks for a stream). It never calls anything and never checks a
// key, so no real model or API key is involved. Run by e2e/run.sh in a throwaway container on the
// stack's network, so the api and worker containers can reach it as an owner-run local server.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = "dozo-e2e-model";
const REPLY = "Hello from the offline Dozo test model.";
let completions = 0;

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(""));
  });
}

createServer(async (request, response) => {
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
            { index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" },
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
    for (const word of REPLY.split(" ")) chunk({ content: `${word} ` });
    chunk({}, "stop", { usage });
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "not found" } }));
}).listen(PORT, "0.0.0.0", () => console.log(`model stub on :${PORT}`));
