// Hosted login end to end, inside the container run.sh starts (README.md). `prepare` downloads the
// server bundle, Node and Postgres the manifest names (checked against its sha256, cached by it)
// and unpacks them; `run` starts a hosted server and computers' servers from them and drives a
// real browser through every case; `serve` keeps a hosted server and one computer's server up for
// the desktop window test. Exit 0 pass, 2 fail.
import { execFile } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const say = (line) => console.log(`[hosted-e2e] ${line}`);
const RUNTIME = "/work/runtime";
const STATE = "/work/state";
const HOSTED = "http://localhost:6173";
const LOCAL = "http://127.0.0.1:5173";
const LEGACY = "http://127.0.0.1:5273";
const PASSWORD = "e2e-password-1234";
/** The longest a server command or a whole step may take before the run fails, saying where. */
const COMMAND_MS = 4 * 60 * 1000;
const STEP_MS = 5 * 60 * 1000;

// --- prepare: the runtime the manifest names ---

async function prepare() {
  const manifest = JSON.parse(
    /^https?:/.test(process.env.MANIFEST)
      ? await (await fetch(process.env.MANIFEST)).text()
      : await readFile(process.env.MANIFEST, "utf8"),
  );
  const platform = manifest.platforms["linux-x64"];
  await mkdir("/cache/dl", { recursive: true });
  await rm(RUNTIME, { recursive: true, force: true });
  for (const part of ["server", "node", "postgres"]) {
    const { url, sha256 } = platform[part];
    const file = `/cache/dl/${sha256}${url.endsWith(".tar.gz") ? ".tar.gz" : ".tar.xz"}`;
    if (!existsSync(file)) {
      if (/^https?:/.test(url)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${part}: ${url} answered ${response.status}`);
        await writeFile(`${file}.part`, Buffer.from(await response.arrayBuffer()));
      } else {
        await copyFile(url.replace(/^file:\/\//, ""), `${file}.part`);
      }
      const sum = createHash("sha256")
        .update(await readFile(`${file}.part`))
        .digest("hex");
      if (sum !== sha256) throw new Error(`${part}: sha256 differs from the manifest`);
      await run("mv", [`${file}.part`, file]);
    }
    const into = path.join(RUNTIME, part);
    await mkdir(into, { recursive: true });
    const strip = part === "server" ? [] : ["--strip-components=1"];
    await run("tar", ["-xf", file, "-C", into, ...strip]);
    say(`${part}: ${path.basename(url)}`);
  }
  await mkdir(STATE, { recursive: true });
}

// --- the servers ---

async function sh(script, args, env) {
  try {
    const { stdout } = await run("bash", [script, ...args], {
      env: { PATH: process.env.PATH, HOME: "/tmp", ...env },
      maxBuffer: 16 * 1024 * 1024,
      // Their own waits are bounded (start: 120 s, each stop: 30 s); this bounds the rest.
      timeout: COMMAND_MS,
      killSignal: "SIGKILL",
    });
    return stdout;
  } catch (error) {
    const what = error.killed
      ? `did not finish in ${COMMAND_MS / 1000} s`
      : error.stderr || error.message;
    throw new Error(`${path.basename(script)} ${args.join(" ")}: ${what}`);
  }
}

/** An Ed25519 key in the form the deploy README makes: base64 of PKCS#8 DER. */
const newKey = () =>
  generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");

const hostedEnv = (keys) => ({
  DOZO_RUNTIME: RUNTIME,
  DOZO_HOME: `${STATE}/hosted`,
  HOSTED_LOGIN_SIGNING_KEY: keys.signing ?? "",
  HOSTED_LOGIN_OVERLAP_KEY: keys.overlap ?? "",
  HOSTED_FAKETIME: keys.faketime ?? "",
});
const hosted = (op, keys) => sh("/repo/dozo/e2e/hosted-login/hosted.sh", [op], hostedEnv(keys));

const COMPUTERS = {
  [LOCAL]: { home: `${STATE}/computer`, pg: 54329, api: 3100, web: 5173 },
  [LEGACY]: { home: `${STATE}/legacy`, pg: 54429, api: 3200, web: 5273 },
};
/** A computer's server, started by the bundle's own start script (the start contract). */
function computer(op, base, issuer) {
  const { home, pg, api, web } = COMPUTERS[base];
  return sh("/repo/dozo/server-bundle/run.sh", [op], {
    DOZO_RUNTIME: RUNTIME,
    DOZO_HOME: home,
    DOZO_PG_PORT: String(pg),
    DOZO_API_PORT: String(api),
    DOZO_WEB_PORT: String(web),
    ...(issuer ? { DOZO_HOSTED_LOGIN_ISSUER: issuer } : {}),
  });
}

/**
 * What the app's window carries for the server on this computer (dozo/desktop/src/local_signup.rs):
 * the single-account server admits a new account only to a request with this cookie, derived from
 * the stack token its start wrote to the home folder.
 */
async function asAppWindow(context, base) {
  const secrets = await readFile(path.join(COMPUTERS[base].home, "secrets.env"), "utf8");
  const token = /^STACK_TOKEN=(.*)$/m.exec(secrets)?.[1];
  check(token, `no stack token in ${base}'s secrets`);
  const value = createHmac("sha256", token).update("rakazo:local-signup").digest("hex");
  await context.addCookies([
    { name: "rakazo_local_signup", value, domain: "127.0.0.1", path: "/api/auth" },
  ]);
}

/** psql as the owner of a server's database, from its own secrets file. */
async function psql(home, port, sql) {
  const secrets = await readFile(path.join(home, "secrets.env"), "utf8");
  const password = /^PG_OWNER_PASSWORD=(.*)$/m.exec(secrets)?.[1];
  const { stdout } = await run(
    `${RUNTIME}/postgres/bin/psql`,
    ["-h", "127.0.0.1", "-p", String(port), "-U", "rakazo", "-d", "rakazo", "-Atc", sql],
    { env: { PGPASSWORD: password } },
  );
  return stdout.trim();
}

// --- the browser ---

function check(condition, what) {
  if (!condition) throw new Error(what);
}

async function openEmailForm(page) {
  const choice = page.getByRole("button", { name: "Continue with email" });
  const email = page.getByPlaceholder("Your email address");
  await email.or(choice).first().waitFor();
  if (await choice.isVisible()) await choice.click();
  await email.waitFor();
}

/** On the hosted sign-in page a computer sent the person to: a new account, then back. */
async function hostedSignUp(page, email) {
  await page.waitForURL((url) => url.origin === HOSTED && url.pathname === "/sign-in");
  check(
    new URL(page.url()).searchParams.get("next")?.startsWith("/dozo/hosted-login?"),
    "next kept",
  );
  await page.getByRole("link", { name: "Sign up" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-up");
  await openEmailForm(page);
  await page.getByPlaceholder("Your name").fill(email.split("@")[0]);
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
}

/** The hosted page that asks the person to agree: names the account, and the person agrees. */
async function agree(page, email) {
  await page
    .getByRole("heading", { name: "Sign in on this computer?" })
    .waitFor({ timeout: 30_000 });
  check(new URL(page.url()).origin === HOSTED, "the confirmation is the hosted server's page");
  check((await page.textContent("body")).includes(email), "the confirmation names the account");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

// The app keeps navigating by itself after a sign-in lands (`/` to `/app`, and to `/sign-in` or
// back once the session changes), so a script run in its page, or a navigation started in it, can
// race the app's own and be torn down with it ("Execution context was destroyed",
// net::ERR_ABORTED). Calls to a server therefore go through the person's cookies without a page
// (`context.request`), and each step that opens a page opens a new tab after closing the old one.

/** A server's answer to the person's own cookies, with the origin a page of it would send. */
function call(context, base, path, body) {
  const headers = {
    origin: base,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };
  return body === undefined
    ? context.request.get(`${base}${path}`, { headers })
    : context.request.post(`${base}${path}`, { headers, data: JSON.stringify(body) });
}

async function session(context, base) {
  return (await call(context, base, "/api/auth/get-session")).json();
}

async function signOut(context, base) {
  const response = await call(context, base, "/api/auth/sign-out", {});
  check(response.ok(), `signed out on ${base}: ${response.status()}`);
}

/** One tab for the person: the ones before it are closed, with whatever they were doing. */
async function freshPage(context) {
  for (const open of context.pages()) await open.close();
  return context.newPage();
}

/** The computer's sign-in page offers only the hosted account: its one button starts. */
async function startHostedSignIn(context, base) {
  const page = await freshPage(context);
  await page.goto(`${base}/sign-in`);
  const button = page.getByRole("button", { name: "Continue", exact: true });
  await button.waitFor();
  check((await page.getByPlaceholder("Password").count()) === 0, "no password form");
  await button.click();
  await page.waitForURL((url) => url.origin === HOSTED);
  return page;
}

/** Back on the computer after the callback: signed in as `email`, and its user id. */
async function landed(page, base, email) {
  await page.waitForURL(
    (url) =>
      url.origin === base &&
      !url.pathname.startsWith("/api/") &&
      !["/sign-in", "/sign-up"].includes(url.pathname),
    { timeout: 30_000 },
  );
  const got = await session(page.context(), base);
  check(got?.user?.email === email, `signed in on ${base} as ${email}, got ${got?.user?.email}`);
  return got.user.id;
}

async function refused(page, base, text) {
  await page.waitForURL((url) => url.origin === base && url.pathname === "/sign-in", {
    timeout: 30_000,
  });
  await page.getByRole("alert").filter({ hasText: text }).waitFor();
}

// --- the cases ---

/** What the current step is doing, for a step that runs out of time. */
const progress = [];
const doing = (what) => {
  progress.push(what);
  say(`  ${what}`);
};

/** Every page load of the run's pages, as `<ms> <url>`: printed for a failed step. */
const loads = [];
function watch(context) {
  context.on("page", (page) =>
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const line = `${Date.now()} ${frame.url()}`;
      loads.push(line);
      if (process.env.HOSTED_E2E_TRACE) say(`load ${line}`);
    }),
  );
  return context;
}

async function cases(browser) {
  const results = [];
  const step = async (name, work) => {
    const started = Date.now();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`did not finish in ${STEP_MS / 1000} s (last: ${progress.at(-1)})`)),
        STEP_MS,
      );
    });
    try {
      await Promise.race([work(), deadline]);
      results.push([name, "ok"]);
      say(`ok   ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      results.push([name, "FAIL"]);
      say(`FAIL ${name}: ${error.message.split("\n")[0]}`);
      say(`page loads before it:\n${loads.slice(-12).join("\n")}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const first = newKey();
  const second = newKey();
  const person = watch(await browser.newContext());
  let page;
  const ada = `ada.${Date.now()}@dozo.example`;
  const eve = `eve.${Date.now()}@dozo.example`;
  let adaLocalId = "";

  await step("servers up: hosted with one key, a new computer with the issuer", async () => {
    await hosted("start", { signing: first });
    await computer("start", LOCAL, HOSTED);
    await asAppWindow(person, LOCAL);
    const keys = await (await fetch(`${HOSTED}/api/auth/dozo/hosted-login/keys`)).json();
    check(keys.keys.length === 1, "one published key");
  });

  await step(
    "first sign-in on an empty computer: sign up on the hosted page, agree, back",
    async () => {
      page = await startHostedSignIn(person, LOCAL);
      await hostedSignUp(page, ada);
      await agree(page, ada);
      adaLocalId = await landed(page, LOCAL, ada);
    },
  );

  await step("signed out, the same account signs in again as the same user", async () => {
    await signOut(person, LOCAL);
    page = await startHostedSignIn(person, LOCAL);
    await agree(page, ada);
    check((await landed(page, LOCAL, ada)) === adaLocalId, "same local user");
    const sessions = await psql(
      COMPUTERS[LOCAL].home,
      COMPUTERS[LOCAL].pg,
      `SELECT round(extract(epoch from max("expiresAt") - now()) / 86400) FROM session`,
    );
    check(Number(sessions) >= 89, `a local session lasts 90 days, got ${sessions}`);
  });

  for (const [label, keys] of [
    ["the new key published beside the old", { signing: first, overlap: second }],
    ["the new key signs, the old one still published", { signing: second, overlap: first }],
    ["the new key alone", { signing: second }],
  ]) {
    await step(`key change, ${label}: sign-in goes on`, async () => {
      await hosted("restart-api", keys);
      const published = await (await fetch(`${HOSTED}/api/auth/dozo/hosted-login/keys`)).json();
      check(published.keys.length === (keys.overlap ? 2 : 1), "keys published");
      await signOut(person, LOCAL);
      page = await startHostedSignIn(person, LOCAL);
      await agree(page, ada);
      check((await landed(page, LOCAL, ada)) === adaLocalId, "same local user");
    });
  }

  await step("a token out of time: the computer says to check its clock", async () => {
    await hosted("restart-api", { signing: second, faketime: "-10m" });
    await signOut(person, LOCAL);
    page = await startHostedSignIn(person, LOCAL);
    await agree(page, ada);
    await refused(page, LOCAL, "Check this computer's date and time");
    await hosted("restart-api", { signing: second });
  });

  await step(
    "hosted account deleted: another is refused until unlink-hosted, then links the user",
    async () => {
      await psql(`${STATE}/hosted`, 54529, `DELETE FROM "user" WHERE email = '${ada}'`);
      const fresh = watch(await browser.newContext());
      await asAppWindow(fresh, LOCAL);
      let other = await startHostedSignIn(fresh, LOCAL);
      await hostedSignUp(other, eve);
      await agree(other, eve);
      await refused(other, LOCAL, "Could not continue");
      const answer = JSON.parse(
        (
          await run(
            `${RUNTIME}/node/bin/node`,
            [
              `${RUNTIME}/server/rakazo-server/dozo-local-account.mjs`,
              "unlink-hosted",
              "--home",
              COMPUTERS[LOCAL].home,
            ],
            { env: { DOZO_PG_BIN: `${RUNTIME}/postgres/bin` } },
          )
        ).stdout,
      );
      check(answer.unlinked === 1, `unlinked one, got ${JSON.stringify(answer)}`);
      other = await startHostedSignIn(fresh, LOCAL);
      await agree(other, eve);
      check((await landed(other, LOCAL, eve)) === adaLocalId, "the same local user, now Eve's");
      await fresh.close();
    },
  );

  await step(
    "a computer with a password account: opens, keeps the password, links from Settings",
    async () => {
      const owner = watch(await browser.newContext());
      let tab = await freshPage(owner);
      const local = `owner.${Date.now()}@dozo.example`;
      const linked = `owner.hosted.${Date.now()}@dozo.example`;
      // A release without hosted sign-in: the computer's own account.
      doing("start the computer without hosted sign-in");
      await computer("start", LEGACY);
      await asAppWindow(owner, LEGACY);
      await tab.goto(`${LEGACY}/sign-up`);
      await openEmailForm(tab);
      await tab.getByPlaceholder("Your name").fill("Owner");
      await tab.getByPlaceholder("Your email address").fill(local);
      await tab.getByPlaceholder("Password").fill(PASSWORD);
      await tab.getByRole("button", { name: "Create account" }).click();
      doing("sign up there with a password");
      const ownerId = await landed(tab, LEGACY, local);
      // A computer someone has used: its first bot exists, so the app opens on the shell.
      doing("make its first bot");
      const made = await call(owner, LEGACY, "/rpc/bots/create", {
        json: {
          name: "Chief",
          title: "",
          description: "",
          notifyOnFinish: true,
          computerMode: "team",
        },
      });
      check(made.ok(), `first bot: ${made.status()} ${(await made.text()).slice(0, 200)}`);
      await signOut(owner, LEGACY);
      doing("stop it");
      await computer("stop", LEGACY);
      // The update turns hosted sign-in on: the server starts, and passwords still work.
      doing("start it with the issuer");
      await computer("start", LEGACY, HOSTED);
      tab = await freshPage(owner);
      await tab.goto(`${LEGACY}/sign-in`);
      await openEmailForm(tab);
      await tab.getByPlaceholder("Your email address").fill(local);
      await tab.getByPlaceholder("Password").fill(PASSWORD);
      await tab.getByRole("button", { name: "Sign in", exact: true }).click();
      doing("sign in with the password");
      check((await landed(tab, LEGACY, local)) === ownerId, "password sign-in as before");
      // Settings > General > Security: link to the hosted account.
      const capabilities = await (await call(owner, LEGACY, "/api/auth/capabilities")).json();
      check(capabilities.hostedLink === true && !capabilities.hostedLogin, "legacy mode");
      doing("open Settings");
      tab = await freshPage(owner);
      await tab.goto(`${LEGACY}/app?settings=general`);
      const row = tab.getByText("Dozo account", { exact: true });
      await row.waitFor({ timeout: 30_000 }).catch(async (error) => {
        await tab.screenshot({ path: "/work/settings.png" }).catch(() => undefined);
        say(`settings at ${tab.url()}: ${(await tab.textContent("body"))?.slice(0, 800)}`);
        throw error;
      });
      doing("link");
      await tab.getByRole("button", { name: "Link", exact: true }).click();
      await tab.waitForURL((url) => url.origin === HOSTED);
      await hostedSignUp(tab, linked);
      await agree(tab, linked);
      doing("back linked");
      check((await landed(tab, LEGACY, linked)) === ownerId, "linked, same user");
      // The password is gone and the way in is the hosted account.
      const closed = (
        await call(owner, LEGACY, "/api/auth/sign-in/email", { email: linked, password: PASSWORD })
      ).status();
      check(closed === 404, `password sign-in closed, got ${closed}`);
      await signOut(owner, LEGACY);
      doing("sign in with the hosted account");
      tab = await startHostedSignIn(owner, LEGACY);
      await agree(tab, linked);
      check((await landed(tab, LEGACY, linked)) === ownerId, "hosted sign-in as the same user");
      doing("close the browser context");
      await owner.close();
    },
  );

  return results;
}

async function browserFor() {
  const { chromium } = await import(`${process.env.PLAYWRIGHT_MODULES}/playwright/index.mjs`);
  return chromium.launch();
}

async function main(mode) {
  if (mode === "prepare") return prepare();
  if (mode === "serve") {
    // For the desktop window test: one hosted server and one new computer, until told to stop.
    await hosted("start", { signing: newKey() });
    await computer("start", LOCAL, HOSTED);
    await writeFile("/shared/ready", `${HOSTED} ${LOCAL}\n`);
    say("serving; waiting for /shared/stop");
    while (!existsSync("/shared/stop")) await new Promise((resolve) => setTimeout(resolve, 1000));
    return;
  }
  const browser = await browserFor();
  try {
    await cases(browser);
  } finally {
    await browser.close();
  }
}

main(process.argv[2]).then(
  () => process.exit(0),
  async (error) => {
    say(`FAILED: ${error.message}`);
    for (const home of ["hosted", "computer", "legacy"]) {
      for (const name of ["migrate.log", "api.log", "web.log", "postgres.log"]) {
        const log = path.join(STATE, home, "logs", name);
        if (existsSync(log))
          say(
            `${home} ${name} (last lines):\n${(await readFile(log, "utf8")).split("\n").slice(-12).join("\n")}`,
          );
      }
    }
    process.exit(2);
  },
);
