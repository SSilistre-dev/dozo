#!/usr/bin/env node
// A stand-in for a local model server, for smoke.sh only: an OpenAI-compatible chat-completions
// endpoint on 127.0.0.1:<port> (default 8001) that answers every request with $SMOKE_REPLY.
// Usage: SMOKE_REPLY=<text> node fake-model.mjs [port]
import http from "node:http";

const REPLY = process.env.SMOKE_REPLY;
if (!REPLY) throw new Error("SMOKE_REPLY is not set");
const port = Number(process.argv[2] ?? 8001);
let calls = 0;

const json = (res, body) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      process.stdout.write(`${new Date().toISOString()} ${req.method} ${req.url}\n`);
      if (req.url.endsWith("/models")) {
        return json(res, { object: "list", data: [{ id: "smoke-1", object: "model" }] });
      }
      if (!req.url.endsWith("/chat/completions")) {
        res.statusCode = 404;
        return res.end("{}");
      }
      calls += 1;
      const base = { id: `c${calls}`, created: 0, model: "smoke-1" };
      const usage = { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 };
      if (!JSON.parse(body || "{}").stream) {
        const message = { role: "assistant", content: REPLY };
        return json(res, {
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason: "stop" }],
          usage,
        });
      }
      res.setHeader("content-type", "text/event-stream");
      const chunk = (choice, extra = {}) =>
        res.write(
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, ...choice }], ...extra })}\n\n`,
        );
      chunk({ delta: { role: "assistant", content: REPLY }, finish_reason: null });
      chunk({ delta: {}, finish_reason: "stop" }, { usage });
      res.end("data: [DONE]\n\n");
    });
  })
  .listen(port, "127.0.0.1");
