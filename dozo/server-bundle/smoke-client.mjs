#!/usr/bin/env node
// The user's first minutes against a running local server, for smoke.sh: sign up with a password
// (no email sender configured), read the session, create a bot, connect the fake local model and
// wait for the bot's answer. Prints one line per step; exit 0 when the bot answered, 2 otherwise.
// With `restored`, against a server restored from a backup of that one: sign in with the same
// password, find the bot and its earlier answer, and get a new answer through the restored model
// connection (its key sealed with the restored encryption key).
// Usage: SMOKE_REPLY=<the fake model's answer> node smoke-client.mjs <web-url> <model-base-url> [restored]

const [base, modelUrl, mode] = process.argv.slice(2);
const restored = mode === "restored";
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
const signup = await call(`/api/auth/${restored ? "sign-in" : "sign-up"}/email`, {
  method: "POST",
  body: JSON.stringify({
    email: "owner@example.test",
    password: "smoke-Password-123",
    ...(restored ? {} : { name: "Owner" }),
  }),
});
if (signup.status !== 200) fail(`sign-in answered ${signup.status}: ${signup.text.slice(0, 300)}`);
cookie = signup.res.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
step(`${restored ? "sign-in" : "sign-up"} 200`);
const session = await call("/api/auth/get-session");
if (session.status !== 200 || !session.text.includes("owner@example.test")) {
  fail(`get-session answered ${session.status} without the new account`);
}
step("session 200");

const replies = async (botId) => {
  const { json } = await call("/rpc/threads/messages", {
    method: "POST",
    body: JSON.stringify({ json: { botId } }),
  }).then((answer) => JSON.parse(answer.text));
  return (json?.messages ?? []).filter(
    (message) => message.role !== "user" && JSON.stringify(message).includes(REPLY),
  ).length;
};

let bot;
if (restored) {
  bot = (await rpc("bots/list")).find((each) => each.name === "Pixel");
  if (!bot) fail("the restored server has no bot named Pixel");
  if ((await replies(bot.id)) !== 1) fail("the restored thread lacks the earlier answer");
  step("bot and its earlier answer restored");
} else {
  bot = await rpc("bots/create", { name: "Pixel", description: "", instructions: "" });
  await rpc("models/connect", {
    provider: "openai-compatible",
    baseUrl: modelUrl,
    modelId: "smoke-1",
    apiKey: "sk-smoke-placeholder",
    apiProtocol: "chat-completions",
    makeDefault: true,
  });
}
const before = restored ? 1 : 0;
const sent = Date.now();
await rpc("threads/send", { botId: bot.id, text: "Are you there?" });
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  if ((await replies(bot.id)) > before) {
    step(`bot replied after ${Date.now() - sent} ms (client total ${Date.now() - started} ms)`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
fail("the bot did not answer within 60 s");
