#!/usr/bin/env node
// The user's first minutes against a running local server, for smoke.sh: sign up with a password
// (no email sender configured), read the session, create a bot, connect the fake local model and
// wait for the bot's answer. Prints one line per step; exit 0 when the bot answered, 2 otherwise.
// With `restored`, against a server restored from a backup of that one: sign in with the same
// password, find the bot and its earlier answer, and get a new answer through the restored model
// connection (its key sealed with the restored encryption key).
// With `reset <dozo-local-account.mjs> <server folder>`: sign in, set a new password with the
// bundle's `account reset-password` while the server runs, then check that the old session and
// password are refused and the new password signs in.
// Usage: SMOKE_REPLY=<the fake model's answer> node smoke-client.mjs <web-url> <model-base-url> [restored]
//        node smoke-client.mjs <web-url> - reset <dozo-local-account.mjs> <server folder>
import { spawnSync } from "node:child_process";

const [base, modelUrl, mode, accountCommand, home] = process.argv.slice(2);
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

const signIn = (password) =>
  call("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: "owner@example.test", password }),
  });
const cookieOf = (answer) =>
  answer.res.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

if (mode === "reset") {
  const NEW = "smoke-New-password-456";
  const before = await signIn("smoke-Password-123");
  if (before.status !== 200) fail(`sign-in before the reset answered ${before.status}`);
  cookie = cookieOf(before);
  const reset = spawnSync(process.execPath, [accountCommand, "reset-password", "--home", home], {
    input: `${NEW}\n`,
    encoding: "utf8",
  });
  if (reset.status !== 0) fail(`reset-password exited ${reset.status}: ${reset.stdout}`);
  const said = JSON.parse(reset.stdout);
  if (said.reset !== true || !(said.sessionsEnded >= 1))
    fail(`reset-password said ${reset.stdout}`);
  step(`reset-password: ${said.sessionsEnded} session(s) ended`);
  const old = await call("/api/auth/get-session");
  if (old.text.includes("owner@example.test"))
    fail("the session from before the reset still works");
  step("old session refused");
  cookie = "";
  if ((await signIn("smoke-Password-123")).status === 200) fail("the old password still signs in");
  step("old password refused");
  const after = await signIn(NEW);
  if (after.status !== 200)
    fail(`the new password answered ${after.status}: ${after.text.slice(0, 200)}`);
  cookie = cookieOf(after);
  const session = await call("/api/auth/get-session");
  if (!session.text.includes("owner@example.test")) fail("no session after signing in anew");
  step("new password signs in");
  process.exit(0);
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
cookie = cookieOf(signup);
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
