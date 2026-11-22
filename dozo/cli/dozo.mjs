#!/usr/bin/env node
// The `dozo` command: talk to your own bots through the bot API (dozo/api/openapi.yaml).
// One file, Node 20 or later, no dependencies. Usage: `dozo help`.

import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_SERVER = "https://app.dozo.bot";
const KEYCHAIN_SERVICE = "dozo-cli";
const TOKEN_SHAPE = /^dozo_pat_[A-Za-z0-9_-]{43}$/;
/** Reconnects in a row without a new event before a follow gives up. */
const MAX_RECONNECTS = 5;

const HELP = `Usage: dozo <command> [options]

  login              Save a token (read from standard input) for the server
  logout             Forget the saved token for the server
  bots               List the bots the token can reach
  chats <bot>        List the bot's other chats (its main chat is the one used without --chat)
  send <bot> [text]  Send a message and print the reply as it comes (text or standard input)
  follow <bot> <run> Follow a run again, after an approval in the app
  export <bot>       Print the chat as Markdown

Options:
  --server <url>     The Dozo server (default: the last one you logged in to, or ${DEFAULT_SERVER})
  --chat <chat>      send, follow, export: one of the bot's chats, by id or name (\`dozo chats\`)
  --after <id>       follow: resume after this event id
  --since <date>     export: only messages from this time on (ISO 8601)
  --no-stream        send: print the run id instead of the reply

Environment: DOZO_TOKEN (used instead of a saved token), DOZO_SERVER.
Exit codes: 0 done, 1 error or the run failed, 3 the bot is waiting for you in the app.`;

export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/**
 * The `dozo follow` line that picks a run up again, naming the chat by its id (never the name typed
 * after --chat), each word quoted where a POSIX shell would otherwise split or run it.
 */
export function followCommand(bot, runId, after, chatQuery) {
  const chat = chatQuery ? ["--chat", decodeURIComponent(chatQuery.slice("chat=".length))] : [];
  return ["dozo", "follow", bot, runId, "--after", after, ...chat]
    .map((word) => {
      const text = String(word);
      return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
    })
    .join(" ");
}

/** Splits arguments into the command, its words and its options. */
export function parseArgs(argv) {
  const words = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--no-stream") options.noStream = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      const value = inline ?? argv[++index];
      if (value === undefined) throw new CliError(`--${name} needs a value`);
      options[name] = value;
    } else words.push(arg);
  }
  return { command: words[0], words: words.slice(1), options };
}

/** The server's origin. A token goes over plain HTTP only to this computer. */
export function serverOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Not a server address: ${value}`);
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new CliError("Use https, or http only for a server on this computer");
  return url.origin;
}

/** The OS keychain: macOS `security`, or `secret-tool` (libsecret) elsewhere. */
export function keychain({ platform = process.platform, run = runCommand } = {}) {
  if (platform === "darwin")
    return {
      get: (origin) =>
        run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", origin, "-w"]),
      // Through `security -i` on standard input, so the token is never in a process's arguments.
      set: (origin, token) =>
        run(
          "security",
          ["-i"],
          `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "${origin}" -w "${token}"\n`,
        ),
      remove: (origin) =>
        run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", origin]),
    };
  if (platform === "linux")
    return {
      get: (origin) =>
        run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "server", origin]),
      set: (origin, token) =>
        run(
          "secret-tool",
          ["store", "--label=Dozo CLI", "service", KEYCHAIN_SERVICE, "server", origin],
          token,
        ),
      remove: (origin) =>
        run("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "server", origin]),
    };
  return null;
}

function runCommand(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15_000 }, (error, stdout) => {
      if (error) reject(new CliError(`${file} failed`));
      else resolve(stdout.trim());
    });
    child.stdin.end(input ?? "");
  });
}

function configFile(env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "dozo", "cli.json");
}

/** The last server logged in to. The token itself is never written here. */
async function savedServer(env) {
  try {
    return JSON.parse(await readFile(configFile(env), "utf8")).server ?? null;
  } catch {
    return null;
  }
}

async function saveServer(env, server) {
  const file = configFile(env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ server }, null, 2)}\n`, { mode: 0o600 });
}

async function readAll(stream) {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

/** One line typed at a terminal without showing it; Ctrl-C stops. */
function readHidden(stdin, stderr, prompt) {
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = (finish) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      finish();
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done(() => resolve(typed));
        if (char === "\u0003") return done(() => reject(new CliError("Stopped", 130)));
        if (char === "\u007f") typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

/** Splits a server-sent event stream into `{ id, event, data }`, skipping comment lines. */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const frame = { id: undefined, event: "message", data: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) frame.id = line.slice(4);
        else if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) frame.data += line.slice(6);
      }
      if (frame.data) yield { ...frame, data: JSON.parse(frame.data) };
      end = buffer.indexOf("\n\n");
    }
  }
}

/**
 * Runs one command. `io` holds the streams and `fetch`, so tests run it without a terminal or a
 * network. Returns the exit code.
 */
export async function main(argv, io) {
  const { env, stdout, stderr } = io;
  const { command, words, options } = parseArgs(argv);
  if (!command || options.help || command === "help") {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  const origin = serverOrigin(
    options.server ?? env.DOZO_SERVER ?? (await savedServer(env)) ?? DEFAULT_SERVER,
  );
  const keys = io.keychain === undefined ? keychain() : io.keychain;

  if (command === "login") {
    const typed = io.stdin.isTTY
      ? await readHidden(io.stdin, stderr, "Token: ")
      : await readAll(io.stdin);
    const token = typed.trim();
    if (!TOKEN_SHAPE.test(token))
      throw new CliError("Paste a token made under Settings > Security > Access tokens");
    if (!keys) throw new CliError("No keychain here: set DOZO_TOKEN instead");
    await keys.set(origin, token);
    await saveServer(env, origin);
    stderr.write(`Saved the token for ${origin}\n`);
    return 0;
  }
  if (command === "logout") {
    const removed = keys
      ? await keys.remove(origin).then(
          () => true,
          () => false,
        )
      : false;
    stderr.write(removed ? `Forgot the token for ${origin}\n` : `No saved token for ${origin}\n`);
    return 0;
  }

  const saved = env.DOZO_TOKEN ? null : keys ? await keys.get(origin).catch(() => "") : "";
  const token = env.DOZO_TOKEN || saved;
  if (!TOKEN_SHAPE.test(token ?? ""))
    throw new CliError(`No token for ${origin}: run \`dozo login\` or set DOZO_TOKEN`);
  const call = async (path, init = {}) => {
    const response = await io.fetch(`${origin}/api/v1/dozo${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new CliError(body.error ?? `The server answered ${response.status}`);
    }
    return response;
  };
  const json = async (path, init) => (await call(path, init)).json();

  /** A bot by its id or, ignoring case, its exact name. */
  const botId = async (name) => {
    if (!name) throw new CliError("Name a bot: `dozo bots` lists them");
    const { bots } = await json("/bots");
    const byId = bots.find((bot) => bot.id === name);
    if (byId) return byId.id;
    const named = bots.filter((bot) => bot.name.toLowerCase() === name.toLowerCase());
    if (named.length === 1) return named[0].id;
    throw new CliError(
      named.length ? `More than one bot is called ${name}: use its id` : `No bot ${name}`,
    );
  };

  /**
   * The chat named with --chat, by its id or, ignoring case, its exact name: a `?chat=` query, or
   * nothing for the bot's main chat. A chat the server does not list is an error, never the main one.
   */
  const chatQuery = async (bot) => {
    const name = options.chat;
    if (name === undefined) return "";
    const { chats } = await json(`/bots/${encodeURIComponent(bot)}/chats`);
    const byId = chats.find((chat) => chat.id === name);
    const named = chats.filter((chat) => chat.name.toLowerCase() === name.toLowerCase());
    const id = byId?.id ?? (named.length === 1 ? named[0].id : null);
    if (!id)
      throw new CliError(
        named.length ? `More than one chat is called ${name}: use its id` : `No chat ${name}`,
      );
    return `chat=${encodeURIComponent(id)}`;
  };
  /** A path with the chat's query, and `extra` query parts after it. */
  const withQuery = (path, ...parts) => {
    const query = parts.filter(Boolean).join("&");
    return query ? `${path}?${query}` : path;
  };

  const eventStream = { accept: "text/event-stream" };
  const resume = (bot, runId, after, chat) =>
    call(
      withQuery(`/bots/${encodeURIComponent(bot)}/runs/${encodeURIComponent(runId)}/events`, chat),
      {
        headers: {
          ...eventStream,
          ...(after === undefined ? {} : { "last-event-id": String(after) }),
        },
      },
    );

  /**
   * Prints a run's events until it ends or waits for the person. `first` opens the first stream
   * (a send); after that, or when a stream drops, the run is followed again after the last id.
   */
  const stream = async (bot, chat, first, start) => {
    let runId = start.runId;
    let last = start.after;
    let streamed = false;
    let next = first;
    for (let quiet = 0; ; quiet++) {
      const response = await next().catch((error) => {
        if (error instanceof CliError) throw error;
        return null;
      });
      try {
        for await (const frame of response ? sseEvents(response.body) : []) {
          if (frame.id !== undefined) {
            last = frame.id;
            quiet = 0;
          }
          const { event, data } = frame;
          if (event === "run") {
            runId = data.runId;
            stderr.write(`run ${runId}\n`);
          } else if (event === "delta") {
            stdout.write(data.text);
            streamed = true;
          } else if (event === "activity") stderr.write(`… ${data.text}\n`);
          else if (event === "message") {
            stdout.write(streamed ? "\n" : `${data.text}\n`);
            streamed = false;
          } else if (event === "status" && data.status !== "running") {
            if (streamed) stdout.write("\n");
            if (data.status === "completed") return 0;
            if (data.status === "waiting_input" || data.status === "waiting_takeover") {
              stderr.write(
                `The bot is waiting for you in the app. Then: ${followCommand(bot, runId, last, chat)}\n`,
              );
              return 3;
            }
            stderr.write(`The run ${data.status}\n`);
            return 1;
          }
        }
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new CliError("The server sent something unreadable");
        // The line dropped: follow the run again below.
      }
      if (!runId) throw new CliError("Lost the connection before the run started");
      if (quiet >= MAX_RECONNECTS) throw new CliError("Lost the connection to the server");
      next = () => resume(bot, runId, last, chat);
    }
  };

  switch (command) {
    case "bots": {
      const { bots } = await json("/bots");
      for (const bot of bots) stdout.write(`${bot.id}\t${bot.name}\n`);
      return 0;
    }
    case "chats": {
      const bot = await botId(words[0]);
      const { chats } = await json(`/bots/${encodeURIComponent(bot)}/chats`);
      for (const chat of chats) stdout.write(`${chat.id}\t${chat.name}\n`);
      return 0;
    }
    case "send": {
      const bot = await botId(words[0]);
      const text = words.length > 1 ? words.slice(1).join(" ") : (await readAll(io.stdin)).trim();
      if (!text)
        throw new CliError("Write a message: as words after the bot, or on standard input");
      const chat = await chatQuery(bot);
      const send = (headers) =>
        call(withQuery(`/bots/${encodeURIComponent(bot)}/messages`, chat), {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ text }),
        });
      if (options.noStream) {
        stdout.write(`${JSON.stringify(await (await send({})).json())}\n`);
        return 0;
      }
      return stream(bot, chat, () => send(eventStream), {});
    }
    case "follow": {
      const bot = await botId(words[0]);
      const runId = words[1];
      if (!runId) throw new CliError("Name the run: `dozo follow <bot> <run>`");
      const chat = await chatQuery(bot);
      return stream(bot, chat, () => resume(bot, runId, options.after, chat), {
        runId,
        after: options.after,
      });
    }
    case "export": {
      const bot = await botId(words[0]);
      const query = new URLSearchParams({
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (options.since) {
        const since = new Date(options.since);
        if (Number.isNaN(since.getTime()))
          throw new CliError("--since needs a date like 2026-11-01");
        query.set("since", since.toISOString());
      }
      const chat = await chatQuery(bot);
      const exported = await json(
        withQuery(`/bots/${encodeURIComponent(bot)}/export`, chat, query),
      );
      stdout.write(exported.markdown);
      if (exported.truncated) stderr.write("The chat is long: only its newest part is here\n");
      return 0;
    }
    default:
      throw new CliError(`Unknown command ${command}: \`dozo help\` lists them`);
  }
}

const direct =
  process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href;
if (direct) {
  const io = {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    fetch,
  };
  process.exitCode = await main(process.argv.slice(2), io).catch((error) => {
    if (!(error instanceof CliError)) throw error;
    process.stderr.write(`dozo: ${error.message}\n`);
    return error.code;
  });
}
