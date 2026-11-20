#!/usr/bin/env node
// The user's first minutes against a running local server, for smoke.sh: sign up with a password
// (no email sender configured), read the session, create a bot, connect the fake local model and
// wait for the bot's answer. Prints one line per step; exit 0 when the bot answered, 2 otherwise.
// Usage: SMOKE_REPLY=<the fake model's answer> node smoke-client.mjs <web-url> <model-base-url>

const [base, modelUrl] = process.argv.slice(2);
const REPLY = process.env.SMOKE_REPLY;
const step = (line) => process.stdout.write(`[client] ${line}\n`);
const fail = (line) => {
  step(`FAILED: ${line}`);
  process.exit(2);
};
let cookie = "";

async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", origin: base, cookie, ...init.headers },
  });
  return { status: res.status, text: await res.text(), res };
}

async function rpc(path, input) {
  const { status, text } = await call(`/rpc/${path}`, {
    method: "POST",
    body: JSON.stringify({ json: input }),
  });
  if (status !== 200) fail(`rpc ${path} answered ${status}: ${text.slice(0, 300)}`);
  step(`rpc ${path} 200`);
  return JSON.parse(text).json;
}

const started = Date.now();
const signup = await call("/api/auth/sign-up/email", {
  method: "POST",
  body: JSON.stringify({
    email: "owner@example.test",
    password: "smoke-Password-123",
    name: "Owner",
  }),
});
if (signup.status !== 200) fail(`sign-up answered ${signup.status}: ${signup.text.slice(0, 300)}`);
cookie = signup.res.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
step("sign-up 200");
const session = await call("/api/auth/get-session");
if (session.status !== 200 || !session.text.includes("owner@example.test")) {
  fail(`get-session answered ${session.status} without the new account`);
}
step("session 200");

const bot = await rpc("bots/create", { name: "Pixel", description: "", instructions: "" });
await rpc("models/connect", {
  provider: "openai-compatible",
  baseUrl: modelUrl,
  modelId: "smoke-1",
  apiKey: "sk-smoke-placeholder",
  apiProtocol: "chat-completions",
  makeDefault: true,
});
const sent = Date.now();
await rpc("threads/send", { botId: bot.id, text: "Are you there?" });
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const { json } = await call("/rpc/threads/messages", {
    method: "POST",
    body: JSON.stringify({ json: { botId: bot.id } }),
  }).then((answer) => JSON.parse(answer.text));
  const reply = json?.messages?.find(
    (message) => message.role !== "user" && JSON.stringify(message).includes(REPLY),
  );
  if (reply) {
    step(`bot replied after ${Date.now() - sent} ms (client total ${Date.now() - started} ms)`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
fail("the bot did not answer within 60 s");
