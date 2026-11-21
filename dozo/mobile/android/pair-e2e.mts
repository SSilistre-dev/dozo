// The computer's end of the Android pairing test (README.md, Android): the real API on
// 127.0.0.1:3110 with one signed-up account and a bot, a dev relay on 127.0.0.1:8787, and the relay
// agent's command line as the desktop app runs it (`run`, `pair`, `approve`). The phone is the
// built app on the emulator: the relay port is reversed into it, so the offer's loopback relay is
// the same address on both ends. Each step's screenshot goes to <out>.
//
// 1. the app opens on its build's server (https://app.dozo.bot); 2. `adb am start` opens the pairing link; 3. the app asks
// "Connect to this computer?" and Connect is tapped; 4. the app shows the approval code, which
// must be the one the agent reports; 5. approved here, the app signs in and lists the bot;
// 6. a link to a settings page opens the access tokens page, whose row for a new token shows.
//
// Usage: tsx pair-e2e.mts <out-dir>, with DOZO_WORKSPACE (a branded tree with its packages
// installed), DATABASE_URL, adb and maestro on PATH and an emulator with the app installed.
// Last line: ANDROID PAIRING E2E: PASS|FAIL. Exit 0 pass, 2 fail.
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ID = "dev.ssilistre.dozo";
const API_PORT = 3110;
const RELAY_PORT = 8787;
const API = `http://127.0.0.1:${API_PORT}`;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const EMAIL = "owner@example.test";
const BOT = "Scout";

const workspace = path.resolve(process.env.DOZO_WORKSPACE ?? "");
const out = path.resolve(process.argv[2] ?? "android-e2e");
const flows = path.join(path.dirname(fileURLToPath(import.meta.url)), "flows");
const say = (line: string) => process.stdout.write(`[android-e2e] ${line}\n`);
const from = (file: string) => pathToFileURL(path.join(workspace, file)).href;
const children: ChildProcess[] = [];
let step = 0;

/** A screenshot of the emulator's screen as it is now, numbered in the order taken. */
async function shot(name: string) {
  step += 1;
  const file = path.join(out, `${String(step).padStart(2, "0")}-${name}.png`);
  await writeFile(file, execFileSync("adb", ["exec-out", "screencap", "-p"]));
  say(`screenshot ${path.basename(file)}`);
}

/**
 * One Maestro flow from ./flows; its own debug output (a screenshot on failure) goes to <out>.
 * Run without blocking: the server and the relay answer the phone from this process meanwhile.
 */
function flow(name: string, env: Record<string, string> = {}) {
  const vars = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  say(`flow ${name}`);
  const args = ["test", "--no-ansi", "--flatten-debug-output", "--debug-output"];
  args.push(path.join(out, "maestro", name), ...vars, path.join(flows, `${name}.yaml`));
  // A flow's own takeScreenshot lands in the directory it runs in.
  const child = spawn("maestro", args, { cwd: out, stdio: "inherit" });
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`flow ${name} failed (exit ${code})`)),
    );
  });
}

/** The relay agent's command line from the workspace, as the desktop app runs the bundled one. */
function agent(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [
      path.join(workspace, "node_modules/tsx/dist/cli.mjs"),
      "packages/adapters/src/dozo-relay-agent.ts",
      ...args,
    ],
    { cwd: workspace, env, stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  return child;
}

/** The JSON lines a child prints, each passed to `seen` until it returns a value. */
function waitForLine<T>(
  child: ChildProcess,
  what: string,
  seconds: number,
  seen: (event: Record<string, unknown>) => T | undefined,
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${what} in ${seconds} s`)), seconds * 1000);
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const found = seen(event);
      if (found === undefined) return;
      clearTimeout(timer);
      lines.close();
      resolve(found);
    });
    child.once("exit", (code) => reject(new Error(`the agent exited ${code} before ${what}`)));
  });
}

async function signUpWithBot() {
  const signedUp = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: process.env.WEB_ORIGIN ?? "" },
    body: JSON.stringify({ email: EMAIL, password: "owner-password-123", name: "Owner" }),
  });
  if (!signedUp.ok) throw new Error(`sign-up answered ${signedUp.status}`);
  const cookie = signedUp.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const created = await fetch(`${API}/rpc/bots/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: process.env.WEB_ORIGIN ?? "" },
    body: JSON.stringify({ json: { name: BOT, instructions: "Answer briefly." } }),
  });
  if (!created.ok)
    throw new Error(`bots/create answered ${created.status}: ${await created.text()}`);
}

async function main() {
  await mkdir(out, { recursive: true });
  const require = createRequire(path.join(workspace, "packages/testkit/package.json"));
  const { configureEnvironment } = await import(
    from("packages/testkit/src/cli/mobile-screenshots.ts")
  );
  const { serve } = await import(pathToFileURL(require.resolve("@hono/node-server")).href);
  const { startDevRelay } = await import(from("packages/adapters/src/dozo-relay-dev-relay.ts"));

  // The server reads the agent's key once and takes it out of its environment: keep a copy.
  const key = randomBytes(32).toString("hex");
  configureEnvironment();
  Object.assign(process.env, { DOZO_RELAY_AGENT_KEY: key, SIGNUPS_ENABLED: "true" });
  await mkdir(process.env.DATA_DIR ?? "", { recursive: true });
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: path.join(workspace, "packages/db"),
    env: process.env,
    stdio: "inherit",
  });
  const { createApp } = await import(from("apps/api/src/app.ts"));
  const handles = await createApp({
    databaseUrl: process.env.DATABASE_URL,
    dataDir: process.env.DATA_DIR,
    apiHost: "0.0.0.0",
    apiUrl: API,
  });
  const server = serve({ fetch: handles.app.fetch, hostname: "0.0.0.0", port: API_PORT });
  const relay = await startDevRelay({ port: RELAY_PORT });
  try {
    await signUpWithBot();
    say(`server at ${API} with ${EMAIL} and the bot ${BOT}; relay at ${relay.url}`);

    const state = await mkdtemp(path.join(tmpdir(), "dozo-relay-"));
    const env = { ...process.env, DOZO_RELAY_AGENT_KEY: key };
    const running = agent(["run", "--origin", API, "--state", state], env);
    const events: Record<string, unknown>[] = [];
    const log = createInterface({ input: running.stdout! });
    log.on("line", (line) => {
      say(`agent: ${line}`);
      try {
        events.push(JSON.parse(line));
      } catch {
        // not an event
      }
    });
    const event = async (name: string, channel: string, seconds: number) => {
      for (let waited = 0; waited < seconds * 2; waited++) {
        const found = events.find((e) => e.event === name && e.channel === channel);
        if (found) return found;
        if (running.exitCode !== null) throw new Error(`the agent exited ${running.exitCode}`);
        await sleep(500);
      }
      throw new Error(`no "${name}" event for the channel in ${seconds} s`);
    };
    const offer = await waitForLine(
      agent(["pair", "--relay", RELAY, "--state", state], env),
      "offer",
      60,
      (line) => (line.event === "offer" ? (line as { channel: string; qr: string }) : undefined),
    );
    await event("connected", offer.channel, 60);
    say(`offer on ${offer.channel}: ${offer.qr.slice(0, 24)}…`);

    execFileSync("adb", ["reverse", `tcp:${RELAY_PORT}`, `tcp:${RELAY_PORT}`], {
      stdio: "inherit",
    });
    await flow("01-first-screen");
    await shot("first-screen");

    // What the phone's camera does with the QR code: a VIEW intent for the link.
    execFileSync(
      "adb",
      ["shell", `am start -a android.intent.action.VIEW -d '${offer.qr}' ${APP_ID}`],
      { stdio: "inherit" },
    );
    await flow("02-connect", { DOZO_RELAY_HOST: `127.0.0.1:${RELAY_PORT}` });
    await event("paired", offer.channel, 30);
    const asked = await event("approval", offer.channel, 60);
    if (asked.platform !== "android") throw new Error(`the phone said it is ${asked.platform}`);
    const code = String(asked.code);
    say(`the computer asks to approve an android phone with the code ${code}`);
    await flow("03-code", { DOZO_CODE: `${code.slice(0, 3)} ${code.slice(3)}` });
    await shot("same-code");

    await waitForLine(
      agent(["approve", "--state", state, "--", offer.channel], env),
      "approved",
      30,
      (line) => (line.event === "approved" ? true : undefined),
    );
    await event("approved", offer.channel, 30);
    await flow("04-chats", { DOZO_BOT: BOT });
    await shot("chats");
    execFileSync(
      "adb",
      ["shell", `am start -a android.intent.action.VIEW -d 'dozo://dozo-access-tokens' ${APP_ID}`],
      { stdio: "inherit" },
    );
    await flow("05-access-tokens");
    await shot("access-tokens");
    say("paired, approved, signed in, the chat list shows the bot, a link opens the access tokens");
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await relay.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await handles.stop().catch((error: unknown) => say(`server stop: ${String(error)}`));
  }
}

main().then(
  () => {
    console.log("ANDROID PAIRING E2E: PASS");
    process.exit(0);
  },
  async (error: unknown) => {
    console.error(error);
    await shot("failure").catch(() => undefined);
    console.log("ANDROID PAIRING E2E: FAIL");
    process.exit(2);
  },
);
