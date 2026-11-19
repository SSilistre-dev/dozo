// Offline test of model-stub.mjs with Node's built-in runner (`make olc`): the stub the e2e suite
// connects to must keep answering the way an OpenAI-compatible server does, or the setup project
// fails minutes into a rate-limited run. A real child process on a free local port.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

let child;
let base;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [new URL("./model-stub.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`stub exited early (${code})`)));
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("model stub on")) resolve();
    });
  });
});

after(() => child?.kill());

const post = (body, path = "/v1/chat/completions") =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body });

test("lists one model on /v1/models and /models", async () => {
  for (const path of ["/v1/models", "/models"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    const list = await response.json();
    assert.equal(list.object, "list");
    assert.deepEqual(
      list.data.map((m) => m.id),
      ["dozo-e2e-model"],
    );
  }
});

test("answers a non-streaming completion with one canned message and usage", async () => {
  const response = await post(JSON.stringify({ messages: [] }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].message.content, "Hello from the offline Dozo test model.");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.usage.total_tokens, 12);
});

test("streams the same reply as server-sent chunks that end with usage and [DONE]", async () => {
  const response = await post(JSON.stringify({ stream: true }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = (await response.text()).split("\n\n").filter(Boolean);
  assert.equal(events.at(-1), "data: [DONE]");
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e.replace(/^data: /, "")));
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(
    chunks
      .map((c) => c.choices[0].delta.content ?? "")
      .join("")
      .trim(),
    "Hello from the offline Dozo test model.",
  );
  const last = chunks.at(-1);
  assert.equal(last.choices[0].finish_reason, "stop");
  assert.equal(last.usage.total_tokens, 12);
});

test("answers a body that is not JSON with 400, and keeps serving", async () => {
  const response = await post("{not json");
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /not JSON/);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("/health reports the completions served so far", async () => {
  const before = (await (await fetch(`${base}/health`)).json()).completions;
  await post(JSON.stringify({}));
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.completions, before + 1);
});

test("a completions path under another prefix works; an unknown path is 404", async () => {
  assert.equal((await post(JSON.stringify({}), "/chat/completions")).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/v1/chat/completions`)).status, 404); // GET is not served
});

test("a query string does not change the route", async () => {
  // Clients append one (an api-version, a cache buster); the path alone decides.
  const models = await fetch(`${base}/v1/models?api-version=1`);
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, "dozo-e2e-model");
  assert.equal((await fetch(`${base}/health?x=1`)).status, 200);
  assert.equal((await post(JSON.stringify({}), "/v1/chat/completions?api-version=1")).status, 200);
});

test("only a literal stream:true streams; false, missing, a string answer JSON", async () => {
  for (const body of [{ stream: false }, {}, { stream: "true" }, { stream: 1 }]) {
    const response = await post(JSON.stringify(body));
    assert.match(response.headers.get("content-type"), /application\/json/, JSON.stringify(body));
    assert.equal((await response.json()).object, "chat.completion");
  }
});
