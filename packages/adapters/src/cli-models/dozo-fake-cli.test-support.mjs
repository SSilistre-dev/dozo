// A stand-in for a provider's CLI on the person's computer, for offline tests of accounts: its
// sign-in, sign-out and status work on the home folder it is given, and a turn answers or hits a
// usage limit depending on that home. Usage: node dozo-fake-cli.test-support.mjs <scenario> <log>
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [scenario, logPath, ...args] = process.argv.slice(2);
const home = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "/", ".claude");
const signedIn = join(home, "signed-in");
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
const done = (text = "", code = 0) => process.stdout.write(text, () => process.exit(code));

log({
  args,
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  home: process.env.HOME,
  path: process.env.PATH,
});

if (args[0] === "--version") {
  done("2.1.311 (Claude Code)\n");
} else if (args[0] === "auth" && args[1] === "status") {
  // A slow status check leaves time to cancel a sign-in while it runs.
  if (scenario === "login-slow-status") await new Promise((resolve) => setTimeout(resolve, 400));
  done(`${JSON.stringify({ loggedIn: existsSync(signedIn) })}\n`);
} else if (args[0] === "auth" && args[1] === "logout") {
  rmSync(signedIn, { force: true });
  done();
} else if (args[0] === "auth" && args[1] === "login") {
  // The sign-in prints an address of its own host, after one that is not.
  process.stdout.write("See https://example.invalid/ad and https://[broken for news.\n");
  process.stderr.write("Sign in (https://claude.ai/oauth/authorize?code=true&state=abc).\n");
  process.stderr.write("Paste the code here if asked: ");
  if (scenario === "login-gives-up") done("", 1);
  else if (scenario === "login-hangs") setInterval(() => {}, 60_000);
  else {
    for await (const line of createInterface({ input: process.stdin })) {
      if (line === "good-code") writeFileSync(signedIn, "");
      done("", line === "good-code" ? 0 : 1);
      break;
    }
  }
} else {
  await turn();
}

async function turn() {
  out({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  for await (const _ of createInterface({ input: process.stdin })) {
    // Reads the conversation to its end.
  }
  const fail = (error, text) => {
    out({
      type: "assistant",
      error,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    out({ type: "result", subtype: "success", is_error: true, num_turns: 1, result: text });
  };
  if (!existsSync(signedIn)) {
    fail("authentication_failed", "Not logged in");
  } else if (existsSync(join(home, "limited"))) {
    // A limit with its reset time, or (with "no-reset" there too) one that does not say.
    const resetsAt = existsSync(join(home, "no-reset"))
      ? undefined
      : Math.floor(Date.now() / 1000) + 3 * 60 * 60;
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt } });
    fail("rate_limit", "You've hit your usage limit for this plan.");
  } else {
    const stream = (event) => out({ type: "stream_event", event });
    stream({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3 } } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    stream({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: `answered from ${process.env.CLAUDE_CONFIG_DIR ? "an added account" : "home"}`,
      },
    });
    stream({ type: "content_block_stop", index: 0 });
    stream({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    });
    stream({ type: "message_stop" });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1 });
  }
  process.exit(0);
}
