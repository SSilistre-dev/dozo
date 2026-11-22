import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  CliError,
  followCommand,
  keychain,
  main,
  parseArgs,
  serverOrigin,
  sseEvents,
} from "./dozo.mjs";

const TOKEN = `dozo_pat_${"t".repeat(43)}`;

/** The fake server's behaviour for the next requests, and what it was asked. */
let handlers;
let requests;
let server;
let origin;

before(async () => {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    const handler = handlers.shift();
    if (!handler) {
      response.writeHead(500).end();
      return;
    }
    handler(request, response, body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  handlers = [];
  requests = [];
});

const json = (status, value) => (_request, response) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const bots = (list = [{ id: "bot-1", name: "Chef" }]) => json(200, { bots: list });
const frame = (event, data, id) =>
  `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** An event stream; `drop` ends the connection without a last status, as a deploy does. */
const events =
  (frames, { drop = false } = {}) =>
  (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const text = `: keepalive\n\n${frames.join("")}`;
    // A drop cuts the connection once what was written has left, with no end to the response.
    if (drop) response.write(text, () => setTimeout(() => response.socket.destroy(), 10));
    else response.end(text);
  };

function sink() {
  let text = "";
  return {
    write: (chunk) => (text += chunk),
    get text() {
      return text;
    },
  };
}

async function run(argv, { env = {}, stdin = "", keychain: keys = null } = {}) {
  const stdout = sink();
  const stderr = sink();
  const io = {
    env: { DOZO_SERVER: origin, DOZO_TOKEN: TOKEN, XDG_CONFIG_HOME: "/nonexistent", ...env },
    stdin: typeof stdin === "string" ? Readable.from([stdin]) : stdin,
    stdout,
    stderr,
    fetch,
    keychain: keys,
  };
  let code;
  let error;
  try {
    code = await main(argv, io);
  } catch (caught) {
    error = caught;
  }
  return { code, error, stdout: stdout.text, stderr: stderr.text };
}

describe("arguments and server", () => {
  it("splits the command, its words and its options", () => {
    assert.deepEqual(parseArgs(["send", "Chef", "hi", "--server=https://a.test", "--no-stream"]), {
      command: "send",
      words: ["Chef", "hi"],
      options: { server: "https://a.test", noStream: true },
    });
    assert.deepEqual(parseArgs(["follow", "Chef", "run-1", "--after", "7", "-h"]).options, {
      after: "7",
      help: true,
    });
    assert.throws(() => parseArgs(["export", "--since"]), CliError);
  });

  it("sends a token over plain HTTP only to this computer", () => {
    assert.equal(serverOrigin("https://app.example.test/path"), "https://app.example.test");
    assert.equal(serverOrigin("http://127.0.0.1:5173/"), "http://127.0.0.1:5173");
    assert.equal(serverOrigin("http://localhost:3000"), "http://localhost:3000");
    assert.equal(serverOrigin("http://[::1]:3000"), "http://[::1]:3000");
    assert.throws(() => serverOrigin("http://192.168.1.5:5173"), /https/);
    assert.throws(() => serverOrigin("http://localhost.evil.test"), /https/);
    assert.throws(() => serverOrigin("not a url"), /Not a server address/);
  });

  it("prints its help", async () => {
    for (const argv of [[], ["help"], ["bots", "--help"]]) {
      const { code, stdout } = await run(argv);
      assert.equal(code, 0);
      assert.match(stdout, /Usage: dozo/);
    }
    assert.equal(requests.length, 0);
  });
});

describe("bots", () => {
  it("lists bots with the token as a bearer", async () => {
    handlers.push(
      bots([
        { id: "bot-1", name: "Chef" },
        { id: "bot-2", name: "Scout" },
      ]),
    );
    const { code, stdout } = await run(["bots"]);
    assert.equal(code, 0);
    assert.equal(stdout, "bot-1\tChef\nbot-2\tScout\n");
    assert.equal(requests[0].url, "/api/v1/dozo/bots");
    assert.equal(requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(requests[0].headers.cookie, undefined);
  });

  it("says what the server refused, never the token", async () => {
    handlers.push(json(401, { error: "Unauthorized" }));
    const refused = await run(["bots"]);
    assert.equal(refused.error.message, "Unauthorized");
    assert.doesNotMatch(`${refused.error.message}${refused.stderr}`, /dozo_pat_/);
    handlers.push((_request, response) => response.writeHead(502).end("bad gateway"));
    assert.equal((await run(["bots"])).error.message, "The server answered 502");
  });

  it("asks for a token when there is none, or a malformed one", async () => {
    for (const env of [{ DOZO_TOKEN: "" }, { DOZO_TOKEN: "dozo_pat_short" }]) {
      const { error } = await run(["bots"], { env });
      assert.match(error.message, /dozo login/);
    }
    assert.equal(requests.length, 0);
  });

  it("refuses a remote server over plain HTTP before sending anything", async () => {
    const { error } = await run(["bots"], { env: { DOZO_SERVER: "http://example.test" } });
    assert.match(error.message, /https/);
    assert.equal(requests.length, 0);
  });
});

describe("send", () => {
  it("prints the reply as it streams and ends when the run completes", async () => {
    handlers.push(
      bots(),
      events([
        frame("run", { runId: "run-1", seq: 4 }, 4),
        frame("activity", { text: "Thinking" }, 5),
        frame("delta", { text: "Pas" }, 6),
        frame("delta", { text: "ta." }, 7),
        frame("message", { id: "m-1", text: "Pasta." }, 8),
        frame("status", { status: "completed" }, 9),
      ]),
    );
    const { code, stdout, stderr } = await run(["send", "chef", "Plan", "dinner"]);
    assert.equal(code, 0);
    assert.equal(stdout, "Pasta.\n");
    assert.match(stderr, /run run-1/);
    assert.match(stderr, /… Thinking/);
    const sent = requests[1];
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "/api/v1/dozo/bots/bot-1/messages");
    assert.equal(sent.headers.accept, "text/event-stream");
    assert.equal(sent.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(sent.body), { text: "Plan dinner" });
  });

  it("reads the message from standard input and prints a message that did not stream", async () => {
    handlers.push(
      bots(),
      events([
        frame("run", { runId: "run-1", seq: 4 }, 4),
        frame("message", { id: "m-1", text: "Done." }, 5),
        frame("status", { status: "completed" }, 6),
      ]),
    );
    const { code, stdout } = await run(["send", "bot-1"], { stdin: "  From a pipe \n" });
    assert.equal(code, 0);
    assert.equal(stdout, "Done.\n");
    assert.deepEqual(JSON.parse(requests[1].body), { text: "From a pipe" });
  });

  it("follows the run again after the last id when the line drops or the stream times out", async () => {
    handlers.push(
      bots(),
      events([frame("run", { runId: "run-1", seq: 4 }, 4), frame("delta", { text: "Pas" }, 5)], {
        drop: true,
      }),
      events([frame("delta", { text: "ta" }, 6), frame("status", { status: "running" })]),
      events([frame("delta", { text: "." }, 7), frame("status", { status: "completed" }, 8)]),
    );
    const { code, stdout } = await run(["send", "Chef", "hi"]);
    assert.equal(code, 0);
    assert.equal(stdout, "Pasta.\n");
    assert.equal(requests[2].url, "/api/v1/dozo/bots/bot-1/runs/run-1/events");
    assert.equal(requests[2].headers["last-event-id"], "5");
    assert.equal(requests[3].headers["last-event-id"], "6");
    // The message itself was sent once.
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  });

  it("stops with exit 3 when the bot waits for an approval, saying how to go on", async () => {
    handlers.push(
      bots(),
      events([
        frame("run", { runId: "run-1", seq: 4 }, 4),
        frame("delta", { text: "Checking" }, 5),
        frame("status", { status: "waiting_input" }, 6),
      ]),
    );
    const { code, stdout, stderr } = await run(["send", "Chef", "Delete it"]);
    assert.equal(code, 3);
    assert.equal(stdout, "Checking\n");
    assert.match(stderr, /dozo follow bot-1 run-1 --after 6/);
  });

  it("exits 1 when the run fails, and when the connection never comes back", async () => {
    handlers.push(
      bots(),
      events([
        frame("run", { runId: "run-1", seq: 4 }, 4),
        frame("status", { status: "failed" }, 5),
      ]),
    );
    const failed = await run(["send", "Chef", "hi"]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /The run failed/);

    handlers.push(bots(), events([frame("run", { runId: "run-1", seq: 4 }, 4)], { drop: true }));
    for (let index = 0; index < 6; index++) handlers.push(events([], { drop: true }));
    const lost = await run(["send", "Chef", "hi"]);
    assert.match(lost.error.message, /Lost the connection to the server/);
  });

  it("never sends the message twice when the line drops before the run starts", async () => {
    handlers.push(bots(), events([], { drop: true }));
    const { error } = await run(["send", "Chef", "hi"]);
    assert.match(error.message, /before the run started/);
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  });

  it("says when the server sends something unreadable", async () => {
    handlers.push(bots(), events(["event: delta\ndata: {not json\n\n"]));
    const { error } = await run(["send", "Chef", "hi"]);
    assert.match(error.message, /unreadable/);
  });

  it("prints where the run starts without streaming, when asked", async () => {
    handlers.push(bots(), json(202, { runId: "run-1", seq: 4 }));
    const { code, stdout } = await run(["send", "Chef", "hi", "--no-stream"]);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { runId: "run-1", seq: 4 });
    assert.notEqual(requests[1].headers.accept, "text/event-stream");
  });

  it("needs a bot it can tell apart and a message", async () => {
    assert.match((await run(["send"])).error.message, /Name a bot/);
    handlers.push(
      bots([
        { id: "bot-1", name: "Chef" },
        { id: "bot-2", name: "chef" },
      ]),
    );
    assert.match((await run(["send", "CHEF", "hi"])).error.message, /use its id/);
    handlers.push(bots());
    assert.match((await run(["send", "Nobody", "hi"])).error.message, /No bot Nobody/);
    handlers.push(bots());
    assert.match((await run(["send", "Chef"], { stdin: "  " })).error.message, /Write a message/);
  });
});

describe("follow", () => {
  it("follows a run after an id, and from now without one", async () => {
    handlers.push(bots(), events([frame("status", { status: "completed" }, 9)]));
    assert.equal((await run(["follow", "Chef", "run-1", "--after", "6"])).code, 0);
    assert.equal(requests[1].url, "/api/v1/dozo/bots/bot-1/runs/run-1/events");
    assert.equal(requests[1].headers["last-event-id"], "6");

    requests = [];
    handlers.push(bots(), events([frame("status", { status: "cancelled" })]));
    const cancelled = await run(["follow", "Chef", "run-1"]);
    assert.equal(cancelled.code, 1);
    assert.equal(requests[1].headers["last-event-id"], undefined);

    handlers.push(bots());
    assert.match((await run(["follow", "Chef"])).error.message, /Name the run/);
  });
});

describe("export", () => {
  it("prints the chat as Markdown, from a date when asked", async () => {
    handlers.push(bots(), json(200, { markdown: "# Chef\n", truncated: true }));
    const { code, stdout, stderr } = await run(["export", "Chef", "--since", "2026-11-01"]);
    assert.equal(code, 0);
    assert.equal(stdout, "# Chef\n");
    assert.match(stderr, /newest part/);
    const query = new URL(requests[1].url, origin).searchParams;
    assert.equal(query.get("since"), "2026-11-01T00:00:00.000Z");
    assert.ok(query.get("timeZone"));

    handlers.push(bots());
    assert.match((await run(["export", "Chef", "--since", "soon"])).error.message, /--since/);
    handlers.push(bots(), json(200, { markdown: "# Chef\n", truncated: false }));
    assert.equal((await run(["export", "Chef"])).stderr, "");
  });

  it("names an unknown command", async () => {
    handlers.push();
    assert.match((await run(["delete"])).error.message, /Unknown command delete/);
  });
});

describe("a bot's other chats", () => {
  const chats = (
    list = [{ id: "chat-1", name: "Garden", createdAt: "2026-11-20T09:00:00.000Z" }],
  ) => json(200, { chats: list });

  it("lists the bot's chats by id and name", async () => {
    handlers.push(bots(), chats());
    const { code, stdout } = await run(["chats", "Chef"]);
    assert.equal(code, 0);
    assert.equal(stdout, "chat-1\tGarden\n");
    assert.equal(requests[1].url, "/api/v1/dozo/bots/bot-1/chats");
  });

  it("sends, follows and exports in a chat named by id or name, and says so when it must wait", async () => {
    handlers.push(
      bots(),
      chats(),
      events([
        frame("run", { runId: "run-1", seq: 4 }, 4),
        frame("status", { status: "waiting_input" }, 5),
      ]),
    );
    const sent = await run(["send", "Chef", "--chat", "garden", "Sow?"]);
    assert.equal(sent.code, 3);
    assert.equal(requests[2].url, "/api/v1/dozo/bots/bot-1/messages?chat=chat-1");
    assert.deepEqual(JSON.parse(requests[2].body), { text: "Sow?" });
    // The chat's id, which the server gave, not the name typed after --chat.
    assert.match(sent.stderr, /dozo follow bot-1 run-1 --after 5 --chat chat-1\n/);

    requests = [];
    handlers.push(bots(), chats(), events([frame("status", { status: "completed" }, 9)]));
    assert.equal((await run(["follow", "Chef", "run-1", "--chat", "chat-1"])).code, 0);
    assert.equal(requests[2].url, "/api/v1/dozo/bots/bot-1/runs/run-1/events?chat=chat-1");

    requests = [];
    handlers.push(bots(), chats(), json(200, { markdown: "# Garden\n", truncated: false }));
    assert.equal((await run(["export", "Chef", "--chat", "Garden"])).stdout, "# Garden\n");
    const url = new URL(requests[2].url, origin);
    assert.equal(url.pathname, "/api/v1/dozo/bots/bot-1/export");
    assert.equal(url.searchParams.get("chat"), "chat-1");
    assert.ok(url.searchParams.get("timeZone"));
  });

  it("names the chat by its id in the line to go on, whatever was typed after --chat", async () => {
    const odd = "Garden; rm -rf ~ $(touch x)";
    handlers.push(
      bots(),
      chats([{ id: "chat-1", name: odd, createdAt: "2026-11-20T09:00:00.000Z" }]),
      events([
        frame("run", { runId: "run-1", seq: 4 }, 4),
        frame("status", { status: "waiting_input" }, 5),
      ]),
    );
    const sent = await run(["send", "Chef", "--chat", odd, "Sow?"]);
    assert.equal(sent.code, 3);
    assert.match(sent.stderr, /Then: dozo follow bot-1 run-1 --after 5 --chat chat-1\n$/);
    assert.ok(!sent.stderr.includes("rm -rf"));
  });

  it("quotes any word of the line to go on that a shell would split or run", () => {
    assert.equal(
      followCommand("bot 1", "run;2", "7", `chat=${encodeURIComponent("it's $(x)")}`),
      "dozo follow 'bot 1' 'run;2' --after 7 --chat 'it'\\''s $(x)'",
    );
    assert.equal(followCommand("bot-1", "run-1", 5, ""), "dozo follow bot-1 run-1 --after 5");
  });

  it("follows a dropped stream again in the same chat", async () => {
    handlers.push(
      bots(),
      chats(),
      events([frame("run", { runId: "run-1", seq: 4 }, 4)], { drop: true }),
      events([frame("status", { status: "completed" }, 5)]),
    );
    assert.equal((await run(["send", "Chef", "--chat", "chat-1", "hi"])).code, 0);
    assert.equal(requests[3].url, "/api/v1/dozo/bots/bot-1/runs/run-1/events?chat=chat-1");
  });

  it("never falls back to the main chat for a chat the server does not list", async () => {
    handlers.push(bots(), chats());
    assert.match(
      (await run(["send", "Chef", "--chat", "Kitchen", "hi"])).error.message,
      /No chat Kitchen/,
    );
    handlers.push(
      bots(),
      chats([
        { id: "chat-1", name: "Garden", createdAt: "2026-11-20T09:00:00.000Z" },
        { id: "chat-2", name: "garden", createdAt: "2026-11-21T09:00:00.000Z" },
      ]),
    );
    assert.match((await run(["export", "Chef", "--chat", "GARDEN"])).error.message, /use its id/);
    assert.equal(requests.filter((request) => request.method === "POST").length, 0);
    assert.ok(requests.every((request) => !request.url.includes("/export")));
  });

  it("asks for no chats without --chat, so a call stays on the main chat as before", async () => {
    handlers.push(bots(), json(200, { markdown: "# Chef\n", truncated: false }));
    await run(["export", "Chef"]);
    assert.ok(requests.every((request) => !request.url.endsWith("/chats")));
    assert.equal(new URL(requests[1].url, origin).searchParams.get("chat"), null);
  });
});

describe("login and logout", () => {
  let home;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "dozo-cli-"));
  });
  after(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  function fakeKeychain() {
    const saved = new Map();
    return {
      saved,
      get: async (key) => saved.get(key) ?? "",
      set: async (key, token) => saved.set(key, token),
      remove: async (key) => {
        if (!saved.delete(key)) throw new Error("none");
      },
    };
  }

  it("saves the token in the keychain and only the server in its settings file", async () => {
    const keys = fakeKeychain();
    const env = { XDG_CONFIG_HOME: home, DOZO_TOKEN: "", DOZO_SERVER: undefined };
    const login = await run(["login", "--server", origin], {
      env,
      stdin: `${TOKEN}\n`,
      keychain: keys,
    });
    assert.equal(login.code, 0);
    assert.equal(keys.saved.get(origin), TOKEN);
    const settings = await readFile(join(home, "dozo", "cli.json"), "utf8");
    assert.deepEqual(JSON.parse(settings), { server: origin });
    assert.doesNotMatch(settings, /dozo_pat_/);

    // The next command uses the saved server and token.
    handlers.push(bots());
    const listed = await run(["bots"], { env, keychain: keys });
    assert.equal(listed.code, 0);
    assert.equal(requests[0].headers.authorization, `Bearer ${TOKEN}`);

    assert.match((await run(["logout"], { env, keychain: keys })).stderr, /Forgot the token/);
    assert.equal(keys.saved.size, 0);
    assert.match((await run(["logout"], { env, keychain: keys })).stderr, /No saved token/);
    assert.match((await run(["logout"], { env, keychain: null })).stderr, /No saved token/);
  });

  /** A terminal: what is typed arrives as keystrokes, and nothing is shown. */
  function terminal(keys) {
    const input = new EventEmitter();
    input.isTTY = true;
    input.raw = [];
    input.setRawMode = (on) => input.raw.push(on);
    input.setEncoding = () => input;
    input.pause = () => input;
    input.resume = () => setImmediate(() => input.emit("data", keys));
    return input;
  }

  it("reads the token typed at a terminal without showing it", async () => {
    const keys = fakeKeychain();
    const input = terminal(`${TOKEN}x\u007f\r`);
    const env = { XDG_CONFIG_HOME: home, DOZO_TOKEN: "" };
    const login = await run(["login"], { env, stdin: input, keychain: keys });
    assert.equal(login.code, 0);
    assert.equal(keys.saved.get(origin), TOKEN);
    assert.deepEqual(input.raw, [true, false]);
    assert.match(login.stderr, /^Token: \n/);
    assert.doesNotMatch(login.stderr + login.stdout, /dozo_pat_/);
    const stopped = await run(["login"], { env, stdin: terminal("abc\u0003"), keychain: keys });
    assert.equal(stopped.error.code, 130);
  });

  it("refuses what is not a token, and a computer without a keychain", async () => {
    const env = { XDG_CONFIG_HOME: home };
    const bad = await run(["login"], { env, stdin: "password123", keychain: fakeKeychain() });
    assert.match(bad.error.message, /Access tokens/);
    const none = await run(["login"], { env, stdin: TOKEN, keychain: null });
    assert.match(none.error.message, /DOZO_TOKEN/);
  });

  it("prefers DOZO_TOKEN to a saved token", async () => {
    const keys = fakeKeychain();
    keys.saved.set(origin, `dozo_pat_${"k".repeat(43)}`);
    handlers.push(bots());
    await run(["bots"], { keychain: keys });
    assert.equal(requests[0].headers.authorization, `Bearer ${TOKEN}`);
  });
});

describe("keychain", () => {
  function recorder(answer = "secret") {
    const calls = [];
    const runCommand = async (file, args, input) => {
      calls.push({ file, args, input });
      return answer;
    };
    return { calls, runCommand };
  }

  it("keeps the token out of every command's arguments on macOS", async () => {
    const { calls, runCommand } = recorder();
    const keys = keychain({ platform: "darwin", run: runCommand });
    assert.equal(await keys.get("https://a.test"), "secret");
    await keys.set("https://a.test", TOKEN);
    await keys.remove("https://a.test");
    assert.deepEqual(calls[0].args, [
      "find-generic-password",
      "-s",
      "dozo-cli",
      "-a",
      "https://a.test",
      "-w",
    ]);
    assert.deepEqual(calls[1].args, ["-i"]);
    assert.match(calls[1].input, new RegExp(`-a "https://a.test" -w "${TOKEN}"`));
    for (const call of calls) assert.doesNotMatch(call.args.join(" "), /dozo_pat_/);
  });

  it("uses secret-tool on Linux, with the token on standard input", async () => {
    const { calls, runCommand } = recorder();
    const keys = keychain({ platform: "linux", run: runCommand });
    await keys.get("https://a.test");
    await keys.set("https://a.test", TOKEN);
    await keys.remove("https://a.test");
    assert.deepEqual(
      calls.map((call) => [call.file, call.args[0]]),
      [
        ["secret-tool", "lookup"],
        ["secret-tool", "store"],
        ["secret-tool", "clear"],
      ],
    );
    assert.equal(calls[1].input, TOKEN);
    for (const call of calls) assert.doesNotMatch(call.args.join(" "), /dozo_pat_/);
  });

  it("has none elsewhere", () => {
    assert.equal(keychain({ platform: "win32" }), null);
  });

  it("runs a real command and reports a failing one", async () => {
    const keys = keychain({ platform: "linux" });
    // No secret-tool in a bare container or CI image: the lookup fails cleanly.
    await assert.rejects(keys.get("https://a.test"), CliError);
  });
});

describe("sseEvents", () => {
  it("joins events split across chunks and skips comments", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "id: 1\nevent: del",
      'ta\ndata: {"text":"a"}\n\n: keepalive\n\n',
      'event: status\ndata: {"status":"completed"}\n\n',
    ];
    const body = Readable.from(chunks.map((chunk) => encoder.encode(chunk)));
    const frames = [];
    for await (const frame of sseEvents(body)) frames.push(frame);
    assert.deepEqual(frames, [
      { id: "1", event: "delta", data: { text: "a" } },
      { id: undefined, event: "status", data: { status: "completed" } },
    ]);
  });
});
