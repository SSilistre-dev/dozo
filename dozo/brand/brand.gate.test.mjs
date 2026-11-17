import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { BINARY_EXT, SHAPES, buildScanner, deadShapes, listFiles, loadConfig, phraseRe } from "./lib.mjs";
import { temps, tempDir, tree, read, shipped, configFile, bare, bareRun, apply, check, scanner, texts } from "./brand.test-support.mjs";

// The leak gate: shapes, phrases, names, binaries, symlinks, closed rows, what must not get through.

describe("leak gate", () => {
  it("passes on a clean tree and on identifiers, kept phrases and allow-listed text", () => {
    const root = tree({
      "src/a.ts": [
        'import "@rakazo/core"; const rakazo_app = RakazoDesktop; // RAKAZO_URL',
        'path("Rakazo.icon"); // fork of Rakazo',
        'const image = "ghcr.io/elie222/rakazo/computer:edge";',
        "const home = `/home/rakazo`;",
      ].join("\n"),
      "src/a.test.ts": "Rakazo rakazo.com",
      "CHANGELOG.md": "Rakazo",
    });
    const res = check(root, configFile());
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "leak gate clean: 1 files scanned\n");
  });

  it("fails with path:line: match for the old name, hosts and repo, one finding per leak", () => {
    const root = tree({
      "src/a.ts": 'ok\nconst t = "Sign in to Rakazo";\n"https://Rakazo.com/x" github.com/elie222/rakazo\nRakazos',
    });
    const res = check(root, configFile());
    assert.equal(res.status, 2);
    const lines = res.stderr.trim().split("\n");
    assert.deepEqual(lines, [
      "src/a.ts:2: Rakazo",
      "src/a.ts:3: Rakazo.com",
      "src/a.ts:3: elie222/rakazo",
      "src/a.ts:4: Rakazos",
      "4 leak(s) of the old brand in 1 files scanned",
    ]);
  });

  it("caps the list at 50 lines and says so only when it capped", () => {
    const capped = check(tree({ "src/a.ts": Array.from({ length: 70 }, () => "Rakazo").join("\n") }), configFile());
    assert.equal(capped.status, 2);
    const lines = capped.stderr.trim().split("\n");
    assert.equal(lines.length, 51);
    assert.match(lines.at(-1), /^70 leak\(s\) of the old brand in 1 files scanned \(list capped at 50\)$/);
    const exact = check(tree({ "src/a.ts": Array.from({ length: 50 }, () => "Rakazo").join("\n") }), configFile());
    assert.equal(exact.stderr.trim().split("\n").length, 51);
    assert.doesNotMatch(exact.stderr, /capped/);
  });

  it("counts the files it scanned, and says when launch checks are on", () => {
    const root = tree({ "src/a.ts": "x", "src/b.ts": "y", "packages/c.ts": "z", "docs/d.md": "Rakazo", "src/e.test.ts": "Rakazo" });
    assert.equal(check(root, configFile()).stdout, "leak gate clean: 3 files scanned\n");
    assert.equal(check(root, configFile(), "--launch").stdout, "leak gate clean: 3 files scanned (launch checks on)\n");
    const dirty = check(tree({ "src/a.ts": "Rakazo", "src/b.ts": "x" }), configFile());
    assert.match(dirty.stderr, /^src\/a\.ts:1: Rakazo\n1 leak\(s\) of the old brand in 2 files scanned\n$/);
  });

  it("is clean right after apply on a tree with new upstream strings, and fails when one is added later", () => {
    const root = tree({ "src/a.ts": 'const a = "Rakazo"; const u = "https://rakazo.com";' });
    const config = configFile();
    assert.equal(apply(root, config).status, 0);
    assert.equal(check(root, config).status, 0);
    fs.appendFileSync(path.join(root, "src/a.ts"), '\nconst later = "New Rakazo copy";\n');
    const res = check(root, config);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /src\/a\.ts:2: Rakazo/);
  });

  it("reports a literal that was not applied once per line", () => {
    const literals = [{ find: "/home/rakazo", replace: "/home/dozo", reason: "path" }];
    const res = check(tree({ "src/a.ts": 'cwd = "/home/rakazo"; other = "/home/rakazo/x"' }), configFile({ literals }));
    assert.equal(res.status, 2);
    assert.equal(res.stderr.match(/literal rule not applied/g).length, 1);
    const scoped = [{ find: "/home/rakazo", replace: "/home/dozo", files: ["src/u.sh"], reason: "one file" }];
    assert.equal(check(tree({ "src/a.ts": "x = '/home/rakazo'" }), configFile({ literals: scoped })).status, 0, "not applicable to this file");
    assert.equal(check(tree({ "src/u.sh": "x = '/home/rakazo'" }), configFile({ literals: scoped })).status, 2);
  });

  it("a finding that sits inside an earlier one is the same leak", () => {
    const { scan } = scanner();
    assert.deepEqual(texts(scan('u = "https://Rakazo.com/x"')), ["Rakazo.com"]);
    assert.deepEqual(texts(scan("Rakazo Rakazo.com")), ["Rakazo", "Rakazo.com"]);
    const lines = scan("a RAKAZO.COM b").map((f) => f.start);
    assert.deepEqual(lines, [2]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("every occurrence of the old name is a leak", () => {
  const leaks = {
    "bullet": "- Ask rakazo to summarise this",
    "numbered list": "1. Tell rakazo what you need",
    "wrapped prompt line starting with a keyword": "if the user asks rakazo to stop, stop",
    "code punctuation in the line": "You are rakazo, helping ${user}.",
    "assignment in the line": "const greeting = `Hello from rakazo`; x = 1;",
    "one word and a period": "rakazo.",
    "one word": "rakazo",
    "quoted word": '"rakazo"',
    "hyphen compound": "built with rakazo-powered tools",
    "hyphen compound after a quote": 'label: "rakazo-powered"',
    "hashtag": "share it #rakazo",
    "possessive": "rakazo's agents",
    "all caps": "RAKAZO IS UPDATING",
    "all caps sentence": "<p>Welcome to RAKAZO</p>",
    "capitalised": "Welcome to Rakazo",
    "handle": "Follow @rakazo for news",
    "text between tags": "<p>Welcome to rakazo</p>",
    "tag with expression": "<p>Welcome to rakazo, {name}</p>",
    "alt attribute": '<img alt="rakazo logo" src={x} />',
    "aria-label": '<button aria-label="Open rakazo menu" />',
    "title": "<a title='About rakazo' />",
    "placeholder": '<input placeholder="Ask rakazo anything" />',
    "prose string": 'const m = "Thanks for trying rakazo, the team";',
    "template string": "const m = `the rakazo team (${n})`;",
    "download name": "`rakazo-export-${d}.zip`",
    "client name": '{ name: "rakazo" }',
    "quoted PascalCase": 'operationName: "RakazoIntrospection"',
    ".po entry": 'msgid "About rakazo"',
    "domain with a TLD": "https://rakazo.ai",
    "email address": "write to hello@rakazo.ai",
    "comment": "// the rakazo container reuses this file",
    "block comment": "/* rakazo is a name here */",
    "founder name": "Signed, Elie",
    "PascalCase glued in prose": "<p>Ask RakazoBot for help</p>",
    "PascalCase glued at the end of a sentence": "Ask RakazoBot.",
    "camelCase glued in prose": "Ask rakazoBot to help you",
    "path-like word that is no listed shape": "see /srv/rakazo/data",
    "hyphen word that is no listed stem": "rakazo-labs",
    "property-looking word with a sentence stop": "rakazo. Next sentence",
    "colon with a space": "rakazo: a name",
  };
  for (const [name, line] of Object.entries(leaks)) {
    it(`flags ${name}`, () => {
      const { scan } = scanner({ leakWords: ["Elie"] });
      assert.ok(scan(line).length >= 1, line);
    });
  }

  it("names the file and line, the right one of a longer file", () => {
    const res = check(tree({ "src/a.tsx": "const a = 1;\nconst b = 2;\n<p>Hi rakazo</p>\n" }), configFile());
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^src\/a\.tsx:3: rakazo\n/);
  });

  it("flags the founder's first name as a whole word only", () => {
    const { scan } = scanner({ leakWords: ["Elie"] });
    assert.deepEqual(texts(scan("<Text>Elie</Text>")), ["Elie"]);
    assert.deepEqual(scan("Elies elie ElieX"), []);
  });

  it("flags social profile links of every host and capitalisation, look-alike hosts too", () => {
    const hosts = [
      "x.com/", "twitter.com/", "github.com/", "facebook.com/", "fb.com/", "instagram.com/", "t.me/", "tiktok.com/@",
      "threads.net/@", "bsky.app/profile/", "linkedin.com/company/", "linkedin.com/in/", "linkedin.com/showcase/",
      "youtube.com/@", "youtube.com/c/", "youtube.com/user/", "youtube.com/channel/", "medium.com/@", "medium.com/",
      "reddit.com/r/", "reddit.com/user/", "reddit.com/u/", "discord.gg/", "discord.com/invite/", "www.x.com/", "mobile.twitter.com/",
      "notgithub.com/",
    ];
    const { scan } = scanner();
    for (const host of hosts) {
      for (const handle of ["rakazo", "Rakazo", "RAKAZO", "rakazo_hq", "rakazoHQ"]) {
        assert.ok(scan(`<a href="https://${host}${handle}">`).length >= 1, `${host}${handle}`);
      }
    }
  });

  it("a PascalCase identifier is code unless it stands between plain words", () => {
    const { scan } = scanner();
    for (const code of [
      "export type RakazoDesktop = {",
      "  desktop: RakazoDesktop | undefined,",
      "import type { RakazoDesktop, UserDeviceSummary } from './x';",
      "const rakazoScreen = 1; const RakazoDesktop = 2; const isRakazoContainer = 3;",
      "  rakazoUserId: input.userId,",
      "`<body><script>RakazoPage.mount(${boot})</script></body>`",
      "window.RakazoPage = { mount };",
      "if (host.rakazoDesktop) return true;",
    ]) {
      assert.deepEqual(scan(code), [], code);
    }
    for (const prose of ["Ask RakazoBot to help", "ask rakazoBot to help", "Hello RakazoBot, welcome", "Ask RakazoBot", "Ask RakazoBot.", "say\tRakazoBot to"]) {
      assert.equal(scan(prose).length, 1, prose);
    }
    assert.deepEqual(texts(scan("Ask RakazoBot to help")), ["Rakazo"]);
  });
});

// One row per identifier shape: what passes (positive), what is still a leak although it looks
// alike (negative), and which samples must stop passing when a letter is glued to the left or right.
const SHAPE_CASES = {
  "package-scope": {
    yes: ['import x from "@rakazo/core";', 'import { y } from "@rakazo/ui-web/button";'],
    no: ["Follow @rakazo for news", "mail me at x@rakazo.ai"],
  },
  "env-name": {
    yes: ["process.env.RAKAZO_HOST", "const d = __RAKAZO_VERSION__;", "SLACK_RAKAZO_BOT_ID", "$RAKAZO_HOME/x"],
    no: ["RAKAZO IS UPDATING", "RAKAZO-X", "XRAKAZO_X"],
    left: ["RAKAZO_HOST"],
  },
  "snake-name": {
    yes: ["rakazo_credit_cents", "__rakazo_catalog__", "lib.rakazo_xcapture_open(x)"],
    no: ["rakazo cents", "rakazo-cents"],
    left: ["rakazo_credit_cents"],
    no2: ["https://github.com/rakazo_hq", "@rakazo_hq"],
  },
  "camel-name": {
    yes: [
      "export type RakazoDesktop = {", "  desktop: RakazoDesktop | undefined,", "const rakazoScreen = 1;", "if (isRakazoContainer(a)) return;", "window.__rakazoApp = 1", "rakazoUserId: 1",
      "new RakazoClient(a)", "class RakazoThing {", "export interface RakazoUpdate {", "x = typeof rakazoScreen", "import type { RakazoDesktop, X } from './y';", "<RakazoLogo />",
      "Promise<RakazoDesktopDevice | null>", "RakazoPage.mount(x)", "host?.rakazoDesktop", '"rakazoDesktop"', "see `rakazoDesktop` here", "(rakazoScreen, detail) => 1",
      // each declaring keyword on its own: a word follows, so no slot would let it through
      "x = new RakazoThing instanceof Y", "class RakazoThing extends Base {", "interface RakazoThing extends Base {", "type RakazoThing<T> = T;", "function rakazoThing () {",
      "for (const rakazoItem of list) {", "let rakazoItem in x", "var rakazoItem as y", "typeof rakazoScreen as string",
      // each closing character of a slot
      "(rakazoA = 1) => 1", "Foo & RakazoDesktop & Bar", "{ RakazoDesktop, X }", "x: RakazoDesktop;", "(event: RakazoDesktopSpeechEvent)", "[RakazoDesktop]", "{ RakazoDesktop }", "Array<Foo | RakazoDesktop>", "(x) => rakazoX,",
    ],
    no: [
      "Rakazo Desktop", "rakazo desktop", "Rakazos", "https://github.com/rakazoHQ", "follow @RakazoHQ",
      "Welcome to RakazoAI Pro", "<b>RakazoPro</b>", "Get RakazoPlus Now", "Open RakazoDesktop Settings", "<h1> RakazoPro </h1>", 'label="Try RakazoPro now"', 'msg = "RakazoPro is here"',
      "RakazoPro", "Hello RakazoBot, Friends", "Ask RakazoBot", 'x = "__rakazoTyping = "', "const f = () => <span>RakazoPro</span>",
      "Rakazoapp(1)", "x = Rakazoapp", "isRakazoapp(x)", "Rakazoapp.run", "Rakazoapp: 1",
      "<p>RakazoPro;</p>", 'msg = "RakazoPro, here"', "\"rakazoDesktop'", "Get RakazoPro, Now",
      "Get A_rakazoPro, now",
    ],
    left: ["RakazoPage.mount(x)", "rakazoScreen: 1"],
  },
  "template-name": {
    yes: ["`rakazo-${randomUUID()}`", 'rm -rf "rakazo-$dir"'],
    no: ["rakazo-powered", "rakazo-{id}"],
    left: ["rakazo-${id}"],
  },
  "namespaced-key": {
    yes: ['"rakazo:thread:1"', 'new URL("rakazo://open")', "rakazo:$id"],
    no: ['{ rakazo: "computer" }', "rakazo: a name", "rakazo:"],
    left: ["rakazo:thread:1"],
  },
  "dotted-key": {
    yes: ['localStorage.getItem("rakazo.uiAppearance")', '"rakazo.botId"', "span.setAttribute('rakazo.run.id', id)", "`rakazo.botId=${botId}`", 'LABEL rakazo.control.aimedScroll="1"', "// Do not filter by rakazo.managed=true: legacy", 'new URL(p, "http://rakazo.invalid")', "https://rakazo.test/api"],
    no: [
      "Welcome to rakazo. Next", "rakazo.", "rakazo.9", "rakazo.botId", "Say rakazo.key now", "Use rakazo.run today", '"rakazo.unknownKey"', '"rakazo.botIdX"', '"Qrakazo.botId"', '"rakazo.fun"', '"https://rakazo.studio/x"',
    ],
  },
  "header": {
    yes: ['"x-rakazo-space-id"', "X-Rakazo-Space-Id: 1", 'startsWith("x-rakazo-")'],
    no: ["xx-rakazo-id", "my-x-rakazo-id", "x-rakazo"],
  },
  "data-attribute": {
    yes: ['<div data-rakazo-surface="auth" />', 'root.setAttribute("data-rakazo-screen-error", "")'],
    no: ["mydata-rakazo-x", "data-rakazo=1", "data-rakazo"],
  },
  "css-name": {
    yes: [".rakazo-logo-avatar { }", "rakazo-organic-avatar-body-idle", "--rakazo-organic-path: 1", "animation: rakazo-avatar-spin 1s", "rakazo-group-avatar", "rakazo-bot-avatar-ring"],
    no: ["rakazo-logo-powered", "rakazo-avatar-glow", "rakazo-bot-powered", "Use the rakazo-logo-avatar class"],
    left: ["rakazo-logo-avatar", "rakazo-organic-float"],
  },
  "dom-event": {
    yes: ['type === "rakazo-page:copy"', 'type: "rakazo-app:host"', '"rakazo-mention:"', '"rakazo-mcp-signin:"', "rakazo-save:$id"],
    no: ["rakazo-page copy", "rakazo-pages:x", "rakazo-page"],
    left: ["rakazo-page:copy"],
  },
  "binary-name": {
    yes: ["exec rakazo-browser --flag", "rakazo-page-browser", "rakazo-focus-or-launch", "rakazo-local-bin.sh", "ld librakazo-xcapture.so", "rakazo-terminal.py"],
    no: ["rakazo-browsers", "rakazo-computers", "rakazo-homes", "xrakazo-browser", "Try the rakazo-browser app", "rakazo-computer-control", "rakazo-browser-evil"],
    left: ["rakazo-browser", "rakazo-proxy"],
    right: ["rakazo-browser", "rakazo-home", "rakazo-xcapture"],
  },
  "service-name": {
    yes: ['serviceName: "rakazo-api"', "rakazo-api-jobs", '"rakazo-worker"', "Project-Id-Version: rakazo-web\\n", "rakazo-sandbox-supervisor", "rakazo-prod"],
    no: ["rakazo-apis", "rakazo-weblog", "rakazo-workers", "rakazo-api-evil", "rakazo-web-labs", "Use rakazo-web today"],
    left: ["rakazo-api"],
    right: ["rakazo-api", "rakazo-worker"],
  },
  "persisted-key": {
    yes: ['name: "rakazo-instance-theme"', '"rakazo-account-export"', "rakazo-turn-document", '"rakazo-slack-install"', 'user.rakazo-bot-id'],
    no: ["rakazo-instance-themes", "rakazo-historyx", "rakazo-accounts", "Open the rakazo-history page now"],
    left: ["rakazo-oauth"],
    right: ["rakazo-oauth", "rakazo-history"],
  },
  "name-prefix": {
    yes: ['"rakazo-shell-"', "`rakazo-snapshot-${id}`", "/^rakazo-bot-[a-z]+$/", 'f"rakazo-ab-{uid}"', 'mkdtemp(join(tmpdir(), "rakazo-mcp-"))'],
    no: ["rakazo-shell-powered", "rakazo-bot-powered", "rakazo-mcp-x"],
    left: ['rakazo-shell-"'],
  },
  "process-marker": {
    yes: ['"rakazo-background-launch $id"', "-i rakazo-c+", "rakazo-cprobe", '"rakazo-write"', "rakazo-coding-agent-probe", "rakazo-cancel-run-work", "rakazo-egress-probe", "rakazo-background-idle"],
    no: ["rakazo-cat", "rakazo-writes", "rakazo-background-launcher", "rakazo-cprobes", "rakazo-c-x", "Run rakazo-write now"],
    left: ["rakazo-write", "rakazo-c"],
    right: ["rakazo-write", "rakazo-c", "rakazo-cprobe"],
  },
  "memory-entity": {
    yes: ["`rakazo-space/${spaceId}`", "`rakazo-bot/${label}--${botId}`"],
    no: ["rakazo-space/home", "rakazo-bot/hello"],
  },
  "image-name": {
    yes: ['"rakazo/computer:local"', "/^rakazo\\/computer(:[\\w][\\w.-]*)?$/", "image rakazo/computer."],
    no: ["rakazo/computers", "github.com/x/rakazo/computer", "rakazo/computer-x"],
    left: ["rakazo/computer"],
  },
  "kdf-context": {
    yes: ['"rakazo/content/v1"', '"rakazo/content-master-key/v1"', '"rakazo/search/v1"', "`rakazo/space-key/v1\\0${id}`"],
    no: ["rakazo/content/v2", "rakazo/other/v1", "my-rakazo/search/v1"],
    left: ["rakazo/search/v1"],
  },
  "hidden-name": {
    yes: ["${HOME}/.rakazo-command-env", '".rakazo-executables.json"', 'relative === ".rakazo"', "`${root}/.rakazo/screens.json`"],
    no: [".rakazo-notes", "x.rakazo-command-env", ".rakazo "],
    left: [".rakazo-command-env"],
  },
  "fs-path": {
    yes: ["/tmp/rakazo/x.log", "/usr/local/bin/rakazo-computer", "/home/desktop/rakazo-home", "/usr/local/lib/librakazo-xcapture.so", "/etc/brave/policies/managed/rakazo.json", "/tmp/rakazo/rakazo-terminal.py", "/home/user/.rakazo-command-env"],
    no: ["/srv/rakazo/x", "github.com/tmp/rakazo", "see /tmp/ rakazo", "/opt/rakazo-pro", "/tmp/rakazo-notes/x"],
  },
  "shell-path": {
    yes: ['cat "$dir/rakazo-proxy.json"', "./rakazo-browser", "$directory/.rakazo-write.XXXXXX", "# --user-data-dir=.../rakazo-browser"],
    no: ["github.com/rakazo-labs", "a/rakazo-x", "cd ~/rakazo-notes", "$dir/rakazo-proxyx"],
  },
  "windows-path": {
    yes: ["`${profile}\\\\rakazo\\\\.runs\\\\${id}`"],
    no: ["C:\\rakazo ", "\\\\rakazo ", "rakazo\\\\x"],
  },
  "dev-database": {
    yes: ['"postgres://rakazo:rakazo@127.0.0.1:5433/rakazo"'],
    no: ['"postgres://rakazo:secret@127.0.0.1:5433/rakazo"', "postgres://user:rakazo@host/other"],
  },
};

describe("identifier shapes", () => {
  it("every shape has a row of samples with a positive and a negative, and every row is a shape", () => {
    assert.deepEqual(Object.keys(SHAPE_CASES).sort(), SHAPES.map((s) => s.name).sort());
    for (const shape of SHAPES) {
      assert.ok(shape.reason && shape.reason.length > 10, `${shape.name} has a reason`);
      assert.ok(shape.re.global, `${shape.name} is global`);
      assert.ok(SHAPE_CASES[shape.name].yes.length >= 1 && SHAPE_CASES[shape.name].no.length >= 1, shape.name);
    }
    assert.equal(new Set(SHAPES.map((s) => s.name)).size, SHAPES.length);
  });

  for (const [name, row] of Object.entries(SHAPE_CASES)) {
    it(`${name}: positives pass, look-alikes and glued forms are leaks`, () => {
      const { scan } = scanner();
      for (const line of row.yes) assert.deepEqual(scan(line), [], `${name} should pass: ${line}`);
      for (const line of [...row.no, ...(row.no2 ?? [])]) assert.ok(scan(line).length >= 1, `${name} should be a leak: ${line}`);
      for (const line of row.left ?? []) {
        for (const glue of ["Q", "7"]) assert.ok(scan(`${glue}${line}`).length >= 1, `${name} must not match glued on the left: ${glue}${line}`);
      }
      for (const line of row.right ?? []) {
        for (const glue of ["x", "Z", "9"]) assert.ok(scan(`${line}${glue}`).length >= 1, `${name} must not match glued on the right: ${line}${glue}`);
      }
    });
  }

  it("a shape matches only the token that holds the name: the rest of the line is still checked", () => {
    const { scan } = scanner();
    assert.deepEqual(texts(scan("@rakazo/core and rakazo")), ["rakazo"]);
    assert.deepEqual(texts(scan("RAKAZO_HOST Rakazo")), ["Rakazo"]);
    // one shape must not destroy another one's context: this URL needs `rakazo:` and `//rakazo:` together
    assert.deepEqual(scan('"postgres://rakazo:rakazo@127.0.0.1:5433/rakazo"'), []);
  });
});

// ---------------------------------------------------------------------------------------------

describe("reviewed phrases", () => {
  it("allow.phrases silences one reviewed occurrence, in its files only, as a whole", () => {
    const allow = { phrases: [{ text: 'update("rakazo rls bypass")', files: ["src/db.ts"], reason: "hash input" }] };
    const config = configFile({ allow });
    assert.equal(check(tree({ "src/db.ts": 'h.update("rakazo rls bypass");' }), config).status, 0);
    const elsewhere = check(tree({ "src/other.ts": 'h.update("rakazo rls bypass");' }), config);
    assert.equal(elsewhere.status, 2, "outside its files the same text is a leak");
  });

  it("a phrase does not cover a longer word or a look-alike image", () => {
    const { scan } = scanner();
    assert.deepEqual(scan("image: ghcr.io/elie222/rakazo/computer:edge"), []);
    assert.deepEqual(scan("image: ghcr.io/elie222/rakazo"), []);
    assert.ok(scan("image: ghcr.io/elie222/rakazo-evil/img").length >= 1);
    assert.ok(scan("image: ghcr.io/elie222/rakazos").length >= 1);
    assert.ok(scan("x ghcr.io/elie222/rakazo2").length >= 1);
    assert.ok(scan("Rakazo.icon").length === 0 && scan("Rakazo.apps").length >= 1);
    assert.ok(scan("Rakazo.icons").length >= 1 && scan("Rakazo.icon-x").length >= 1);
    assert.ok(scan("xghcr.io/elie222/rakazo").length >= 1, "no glued left side");
  });

  it("phraseRe: boundaries only next to word characters, and only when the phrase ends or starts with one", () => {
    const ends = phraseRe("a.b");
    assert.ok(ends.test("x a.b y") && (ends.lastIndex = 0, !ends.test("a.bc")) && (ends.lastIndex = 0, !ends.test("a.b-c")) && (ends.lastIndex = 0, !ends.test("xa.b")) && (ends.lastIndex = 0, !ends.test("x-a.b")));
    const dotted = phraseRe(".update(x)");
    assert.ok(dotted.test("h.update(x)") && (dotted.lastIndex = 0, dotted.test(".update(x)y")), "no boundary at a non-word edge");
  });

  it("allow.text silences a text in one file only, and the rest of that file is still checked", () => {
    const allow = { text: [{ file: "src/a.ts", text: 'originator: "rakazo"', reason: "vendor" }] };
    const config = configFile({ allow });
    assert.equal(check(tree({ "src/a.ts": 'const h = { originator: "rakazo" };' }), config).status, 0);
    assert.equal(check(tree({ "src/b.ts": 'const h = { originator: "rakazo" };' }), config).status, 2, "another file");
    assert.equal(check(tree({ "src/a.ts": '<p>Welcome to rakazo</p>' }), config).status, 2, "other text in the same file");
    assert.equal(check(tree({ "src/a.ts": 'originator: "rakazo" + "rakazo"' }), config).status, 2, "a second occurrence outside the text");
  });

  it("the shipped allow.text entries cover their text in their file and nothing else there or elsewhere", () => {
    const light = { ...shipped, anchored: [], assets: {} };
    const file = path.join(tempDir(), "brand.json");
    fs.writeFileSync(file, JSON.stringify(light));
    const { scan } = buildScanner(loadConfig(file));
    assert.ok(shipped.allow.text.length > 0);
    for (const entry of shipped.allow.text) {
      assert.deepEqual(scan(entry.file, entry.text), [], `${entry.file}: ${entry.text}`);
      assert.ok(scan(entry.file, `<p>Welcome to rakazo</p> ${entry.text}`).length >= 1, `${entry.file}: other text in the file is checked`);
      assert.ok(scan("packages/other.ts", entry.text).length >= 1, `${entry.text}: reviewed in ${entry.file} only, and not already covered by a shape`);
    }
  });
});

describe("file and directory names", () => {
  it("a name that carries the old brand is reported once per path, unless reviewed in allow.paths", () => {
    const root = tree({ "src/rakazo-x.ts": "x", "src/Rakazo.icon/a.ts": "x", "src/Rakazo.icon/b.ts": "x", "docs/rakazo.md": "x", "src/ok.ts": "x" });
    const res = check(root, configFile());
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^src\/Rakazo\.icon: file or directory name carries the old brand/m);
    assert.match(res.stderr, /^src\/rakazo-x\.ts: file or directory name/m);
    assert.equal(res.stderr.match(/Rakazo\.icon:/g).length, 1, "the directory once, not once per file");
    assert.doesNotMatch(res.stderr, /docs\/rakazo\.md/, "outside the file set");
    assert.match(res.stderr, /^2 leak\(s\)/m);
    const allow = { paths: [{ glob: "src/rakazo-x.ts", reason: "bin" }, { glob: "src/Rakazo.icon", reason: "icon bundle" }] };
    assert.equal(check(root, configFile({ allow })).status, 0);
    const onlyDir = check(root, configFile({ allow: { paths: [{ glob: "src/Rakazo.icon", reason: "icon bundle" }] } }));
    assert.match(onlyDir.stderr, /src\/rakazo-x\.ts/);
    assert.doesNotMatch(onlyDir.stderr, /Rakazo\.icon:/);
  });

  it("a nested file under a reviewed directory is not reported, a brand-named file inside it is", () => {
    const root = tree({ "src/Rakazo.icon/Assets/rakazo-x.ts": "x" });
    const res = check(root, configFile({ allow: { paths: [{ glob: "src/Rakazo.icon", reason: "bundle" }] } }));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^src\/Rakazo\.icon\/Assets\/rakazo-x\.ts:/m);
  });
});

describe("images and binaries in the gate", () => {
  const mk = () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "ours.png"), Buffer.from([1, 0, 2, 3]));
    return { file: path.join(dir, "brand.json") };
  };
  const base = { from: "Rakazo", to: "Dozo", include: ["apps/**"], assets: { "apps/web/public/i.png": "ours.png" } };
  const put = (root, rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  };

  it("apply copies the asset and the gate accepts it; an upstream file fails the gate", () => {
    const { file } = mk();
    fs.writeFileSync(file, JSON.stringify(base));
    const root = tree({ "apps/web/a.ts": "x" });
    put(root, "apps/web/public/i.png", Buffer.from([9, 0, 9]));
    assert.equal(check(root, file).status, 2);
    assert.equal(apply(root, file).status, 0);
    assert.deepEqual(fs.readFileSync(path.join(root, "apps/web/public/i.png")), Buffer.from([1, 0, 2, 3]));
    assert.equal(check(root, file).status, 0);
  });

  it("an unmapped binary file fails the gate until it is reviewed in allow.binary, for every binary type", () => {
    const { file } = mk();
    const types = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "icns", "tif", "tiff", "heic", "jfif", "jp2", "apng", "pdf", "woff", "woff2", "ttf", "otf", "eot", "mp4", "webm", "lottie", "riv", "PNG"];
    for (const ext of types) {
      fs.writeFileSync(file, JSON.stringify(base));
      const root = tree({ "apps/web/a.ts": "x" });
      put(root, "apps/web/public/i.png", Buffer.from([1, 0, 2, 3]));
      put(root, `apps/web/public/new.${ext}`, Buffer.from([7, 0]));
      const res = check(root, file);
      assert.equal(res.status, 2, ext);
      assert.match(res.stderr, new RegExp(`new\\.${ext}: binary file neither mapped`), ext);
      fs.writeFileSync(file, JSON.stringify({ ...base, allow: { binary: [{ glob: `apps/web/public/new.${ext}`, reason: "r" }] } }));
      assert.equal(check(root, file).status, 0, ext);
    }
    assert.ok(BINARY_EXT.test("a.TIFF"));
    assert.ok(!BINARY_EXT.test("a.png.txt") && !BINARY_EXT.test("png"));
  });

  it("scans the text of an svg that is reviewed but not mapped", () => {
    const { file } = mk();
    fs.writeFileSync(file, JSON.stringify({ ...base, allow: { binary: [{ glob: "apps/web/public/logo.svg", reason: "r" }] } }));
    const root = tree({});
    put(root, "apps/web/public/i.png", Buffer.from([1, 0, 2, 3]));
    put(root, "apps/web/public/logo.svg", "<svg><title>Rakazo</title></svg>");
    const res = check(root, file);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /logo\.svg:1: Rakazo/);
    put(root, "apps/web/public/logo.svg", "<svg><title>Dozo</title></svg>");
    assert.equal(check(root, file).status, 0);
  });
});

describe("launch gate", () => {
  it("flags the url targets and upstream image names only with --launch, and only where they apply", () => {
    const root = tree({ "src/a.ts": 'u = "https://dozo.example/x"; r = "github.com/OWNER/dozo"; i = "ghcr.io/elie222/rakazo/app"' });
    const config = configFile({ urls: { "rakazo.com": "dozo.example", "github.com/elie222/rakazo": "github.com/OWNER/dozo" } });
    assert.equal(check(root, config).status, 0);
    const res = check(root, config, "--launch");
    assert.equal(res.status, 2);
    for (const text of ["dozo.example", "github.com/OWNER/dozo", "ghcr.io/elie222/rakazo"]) assert.ok(res.stderr.includes(`src/a.ts:1: ${text} (launch placeholder)`), text);
    const other = check(tree({ "packages/a.ts": 'i = "ghcr.io/elie222/rakazo/app"' }), config, "--launch");
    assert.equal(other.status, 2);
    assert.match(other.stderr, /packages\/a\.ts:1: elie222\/rakazo\n/, "outside the phrase's files it is a plain leak, not a launch placeholder");
    assert.doesNotMatch(other.stderr, /launch placeholder/);
  });

  it("placeholders come from the url targets, whatever they are", () => {
    const config = configFile({ urls: { "rakazo.com": "acme.example" } });
    const root = tree({ "src/a.ts": 'u = "acme.example"; v = "dozo.example"' });
    const res = check(root, config, "--launch");
    assert.equal(res.status, 2);
    assert.match(res.stderr, /src\/a\.ts:1: acme\.example \(launch placeholder\)/);
    assert.doesNotMatch(res.stderr, /dozo\.example/);
    const none = check(tree({ "src/a.ts": 'v = "dozo.example"' }), configFile({ urls: {} }), "--launch");
    assert.equal(none.status, 0, none.stderr);
  });

  it("--launch skips an allow.phrases entry marked permanent and flags the rest", () => {
    const allow = {
      phrases: [
        { text: "ghcr.io/elie222/rakazo", files: ["src/**"], reason: "image" },
        { text: 'update("rakazo rls bypass")', files: ["src/**"], reason: "hash input", permanent: true },
      ],
    };
    const config = configFile({ allow, urls: {} });
    const root = tree({ "src/a.ts": 'h.update("rakazo rls bypass");' });
    assert.equal(check(root, config, "--launch").status, 0);
    const res = check(tree({ "src/b.ts": "i = ghcr.io/elie222/rakazo" }), config, "--launch");
    assert.equal(res.status, 2);
    assert.match(res.stderr, /src\/b\.ts:1: ghcr\.io\/elie222\/rakazo \(launch placeholder\)/);
  });
});

describe("leak gate and symlinks", () => {
  it("passes a symlink whose target is inside the tree", () => {
    const root = tree({ "src/a.ts": "Dozo" });
    fs.symlinkSync("a.ts", path.join(root, "src/b.ts"));
    const res = check(root, configFile());
    assert.equal(res.status, 0, res.stderr);
  });

  it("fails on a symlink pointing outside the tree, a dangling one, and one into a sibling that shares the prefix", () => {
    const outside = tree({ "secret.ts": "Rakazo" });
    const root = tree({ "src/a.ts": "Dozo" });
    const sibling = `${root}2`;
    fs.mkdirSync(sibling);
    temps.push(sibling);
    fs.writeFileSync(path.join(sibling, "x.ts"), "Rakazo");
    fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "src/out.ts"));
    fs.symlinkSync("nowhere.ts", path.join(root, "src/dangling.ts"));
    fs.symlinkSync(path.join(sibling, "x.ts"), path.join(root, "src/sibling.ts"));
    const res = check(root, configFile());
    assert.equal(res.status, 2);
    for (const name of ["out", "dangling", "sibling"]) assert.match(res.stderr, new RegExp(`src/${name}\\.ts: symlink`));
  });
});

describe("leak gate and symlinks in scope", () => {
  it("fails on a link in scope whose in-tree target is outside the scanned paths, file or directory", () => {
    const root = tree({ "src/a.ts": "Dozo", "docs/leak.ts": "Rakazo", "docs/dir/x.ts": "Rakazo" });
    fs.symlinkSync("../docs/leak.ts", path.join(root, "src/file.ts"));
    fs.symlinkSync("../docs/dir", path.join(root, "src/dir"));
    const res = check(root, configFile());
    assert.equal(res.status, 2);
    assert.match(res.stderr, /src\/file\.ts: symlink whose target docs\/leak\.ts is in the tree but outside the scanned paths/);
    assert.match(res.stderr, /src\/dir: symlink whose target docs\/dir is in the tree but outside the scanned paths/);
  });

  it("passes a directory link into scope, and a link outside the scanned paths", () => {
    const root = tree({ "src/a/x.ts": "Dozo", "docs/note.md": "Dozo" });
    fs.symlinkSync("a", path.join(root, "src/b"));
    fs.symlinkSync("note.md", path.join(root, "docs/other.md"));
    const res = check(root, configFile());
    assert.equal(res.status, 0, res.stderr);
  });
});

describe("runtime directories", () => {
  it("never walks the top-level data/ of the stage or a nested dozo/.stage", () => {
    const root = tree({ "data/a.txt": "Rakazo", "dozo/.stage/src/a.txt": "Rakazo", "src/a.txt": "Rakazo", "src/data/b.txt": "Rakazo" });
    fs.chmodSync(path.join(root, "data"), 0o000); // root-owned on Linux: unreadable, must not crash
    const res = apply(root, configFile({ include: ["**"] }));
    fs.chmodSync(path.join(root, "data"), 0o755);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(read(root, "data/a.txt"), "Rakazo");
    assert.equal(read(root, "dozo/.stage/src/a.txt"), "Rakazo");
    assert.equal(read(root, "src/a.txt"), "Dozo");
    assert.equal(read(root, "src/data/b.txt"), "Dozo");
  });
});

// ---------------------------------------------------------------------------------------------


// ---------------------------------------------------------------------------------------------
// Closure checks of the leak gate

/** One line per stem of a closed row, as the tree holds it; `tail` is glued right after the stem. */
const STEM_SAMPLES = {
  "dotted-key": (stem, tail = "") => `"rakazo.${stem}${tail}"`,
  "css-name": (stem, tail = "") => `.rakazo-${stem}${tail} { }`,
  "dom-event": (stem, tail = "") => `type === "rakazo-${stem}${tail}:x"`,
  "binary-name": (stem, tail = "") => `exec rakazo-${stem}${tail} --x`,
  "service-name": (stem, tail = "") => `name: "rakazo-${stem}${tail}"`,
  "persisted-key": (stem, tail = "") => `"rakazo-${stem}${tail}"`,
  "name-prefix": (stem, tail = "") => `"rakazo-${stem}${tail}-"`,
  "process-marker": (stem, tail = "") => `pkill -f rakazo-${stem}${tail}`,
  "memory-entity": (stem, tail = "") => "`rakazo-" + stem + tail + "/${id}`",
  "kdf-context": (stem, tail = "") => `"rakazo/${stem}${tail}/v1"`,
  "fs-path": (stem, tail = "") => `/tmp/rakazo${stem}${tail}`,
  "shell-path": (stem, tail = "") => `$dir/rakazo${stem}${tail}`,
};
const allSamples = () => [
  ...Object.values(SHAPE_CASES).flatMap((row) => row.yes),
  ...SHAPES.filter((shape) => shape.stems).flatMap((shape) => shape.stems.map((stem) => STEM_SAMPLES[shape.name](stem))),
];

describe("closed shape rows", () => {
  it("every stem of a closed row has a sample that passes, and is a leak when a letter is glued after it", () => {
    const { scan } = scanner();
    const closed = SHAPES.filter((shape) => shape.stems);
    assert.deepEqual(closed.map((shape) => shape.name).sort(), Object.keys(STEM_SAMPLES).sort());
    for (const shape of closed) {
      for (const stem of shape.stems) {
        assert.deepEqual(scan(STEM_SAMPLES[shape.name](stem)), [], `${shape.name}: ${stem}`);
        // a css name carries on with [\w-]*, so a glued letter is still the same class name
        if (shape.name !== "css-name") assert.ok(scan(STEM_SAMPLES[shape.name](stem, "x")).length >= 1, `${shape.name}: ${stem}x`);
      }
    }
  });

  it("the dotted keys are a closed list and need a code-like neighbourhood", () => {
    const { scan } = scanner();
    assert.deepEqual(SHAPES.find((shape) => shape.name === "dotted-key").stems.includes("key"), false);
    for (const line of ['"rakazo.fun"', "see rakazo.run now", "Use rakazo.managed today", "rakazo.botId", "x = rakazo.test;"]) assert.ok(scan(line).length >= 1, line);
    for (const line of ['x = "rakazo.run"', "`rakazo.run`", "http://rakazo.test", "managed/rakazo.json", "rakazo.managed=true", "rakazo.control.aimedScroll=1"]) assert.deepEqual(scan(line), [], line);
  });

  it("an identifier between plain words is prose, in code it is not", () => {
    const { scan } = scanner();
    for (const line of ["Try the rakazo-browser app", "Use rakazo-web today", "Say rakazo-write now", "the rakazo-history key is", "the rakazo-logo-avatar class is"]) assert.ok(scan(line).length >= 1, line);
    for (const line of ["exec rakazo-browser --flag", "pkill -f rakazo-write", 'if (name === "rakazo-web") x()', "see rakazo-browser, then", "cp rakazo-browser /usr/local/bin/x", "run rakazo-browser", "rakazo-browser starts"]) assert.deepEqual(scan(line), [], line);
  });

  it("deadShapes names a row or a stem the tree never uses", () => {
    const lines = allSamples();
    assert.deepEqual(deadShapes([lines.join("\n")]), []);
    assert.deepEqual(deadShapes([lines.filter((line) => !line.includes("api-jobs")).join("\n")]), [{ shape: "service-name", stem: "api-jobs" }]);
    assert.deepEqual(deadShapes([lines.filter((line) => !line.includes("\\\\")).join("\n")]), [{ shape: "windows-path" }]);
    assert.equal(deadShapes(["const x = 1"]).length, SHAPES.length);
  });

  it("apply --strict with the shipped config fails on a row or stem the tree never uses, and a custom config is not held to the table", () => {
    const lines = allSamples();
    const run = (kept) => bareRun("apply.mjs", "--root", tree({ "apps/web/src/samples.ts": kept.join("\n") }), "--strict");
    assert.doesNotMatch(run(lines).stderr, /dead shapes/);
    const noStem = run(lines.filter((line) => !line.includes("api-jobs")));
    assert.equal(noStem.status, 2);
    assert.match(noStem.stderr, /dead shapes\.stems entry \(matches nothing in the tree, delete it\): service-name: api-jobs/);
    const noRow = run(lines.filter((line) => !line.includes("\\\\")));
    assert.match(noRow.stderr, /dead shapes entry \(matches nothing in the tree, delete it\): windows-path/);
    assert.doesNotMatch(apply(tree({ "src/a.ts": "Rakazo" }), bare(), "--strict").stderr, /dead shapes/);
  });
});

describe("allow.text counts its occurrences", () => {
  const entry = (extra = {}) => ({ file: "src/a.ts", text: '"rakazo"', reason: "enum", ...extra });
  const one = 'const a = { label: "rakazo" };';
  const two = `${one}\nconst b = { label: "rakazo", };`;

  it("the gate fails on a second occurrence, on a missing one, and `count` says how many there are", () => {
    const config = (extra) => configFile({ allow: { text: [entry(extra)] } });
    assert.equal(check(tree({ "src/a.ts": one }), config()).status, 0);
    const more = check(tree({ "src/a.ts": two }), config());
    assert.equal(more.status, 2);
    assert.match(more.stderr, /^src\/a\.ts: allow\.text "rakazo" occurs 2 times, expected 1/m);
    assert.equal(check(tree({ "src/a.ts": two }), config({ count: 2 })).status, 0);
    assert.match(check(tree({ "src/a.ts": one }), config({ count: 2 })).stderr, /occurs 1 times, expected 2/);
    assert.match(check(tree({ "src/a.ts": "const x = 1;" }), config()).stderr, /occurs 0 times, expected 1/);
  });

  it("apply --strict fails on more or fewer than `count`, and on none at all", () => {
    const config = (extra) => bare({ allow: { text: [entry(extra)] } });
    assert.equal(apply(tree({ "src/a.ts": one }), config(), "--strict").status, 0);
    const more = apply(tree({ "src/a.ts": two }), config(), "--strict");
    assert.equal(more.status, 2);
    assert.match(more.stderr, /allow\.text src\/a\.ts: "rakazo" occurs 2 times, expected 1/);
    assert.equal(apply(tree({ "src/a.ts": two }), config({ count: 2 }), "--strict").status, 0);
    assert.match(apply(tree({ "src/a.ts": one }), config({ count: 2 }), "--strict").stderr, /occurs 1 times, expected 2/);
    assert.match(apply(tree({ "src/a.ts": "const x = 1;" }), config(), "--strict").stderr, /dead allow\.text entry/);
  });
});


describe("what the gate must not let through", () => {
  it("a URL target on a public TLD is ours, another TLD with the fork's name is not", () => {
    const config = configFile({ urls: { "rakazo.com": "dozo.com" } });
    assert.equal(check(tree({ "src/a.ts": 'u = "https://dozo.com/x"' }), config).status, 0);
    const other = check(tree({ "src/a.ts": 'u = "https://dozo.net/x"' }), config);
    assert.equal(other.status, 2);
    assert.match(other.stderr, /src\/a\.ts:1: dozo\.net \(brand domain\)/);
  });

  it("a keep phrase present only outside its files is dead", () => {
    const root = tree({ "src/a.ts": "Rakazo.icon", "src/b.ts": "Rakazo" });
    const keep = [{ text: "Rakazo.icon", files: ["src/a.ts"], reason: "r" }, { text: "Rakazo.icon", files: ["src/b.ts"], reason: "r" }];
    const res = apply(root, bare({ keep }), "--strict");
    assert.equal(res.status, 2);
    assert.match(res.stderr, /dead keep entry.*Rakazo\.icon/);
    assert.equal((res.stderr.match(/dead keep entry/g) ?? []).length, 1, "only the entry for src/b.ts");
  });

  it("an unreadable directory exits 2 with a message, in apply and in the gate", { skip: process.getuid?.() === 0 && "root can read any directory, permissions cannot be enforced" }, () => {
    const root = tree({ "src/a.ts": "Dozo", "src/locked/b.ts": "x" });
    fs.chmodSync(path.join(root, "src/locked"), 0o000);
    try {
      for (const script of [apply, check]) {
        const res = script(root, configFile());
        assert.equal(res.status, 2, `${script.name}: ${res.stderr}`);
        assert.match(res.stderr, /^dozo-brand: unexpected error: /);
        assert.doesNotMatch(res.stderr, /\n\s+at /);
      }
    } finally {
      fs.chmodSync(path.join(root, "src/locked"), 0o755);
    }
  });

  it("a name that only the quote back-reference ties together is not a whole string", () => {
    const { scan } = scanner();
    assert.deepEqual(texts(scan('x = "RakazoName"')), ['"RakazoName"']);
    assert.deepEqual(texts(scan("x = `RakazoName`")), ["`RakazoName`"]);
    assert.deepEqual(texts(scan("x = \"RakazoName'")), ["Rakazo"]);
  });

  it("a URL target that ends in a non-word character has nothing glued to it", () => {
    const config = configFile({ urls: { "rakazo.com": "dozo.example/" } });
    assert.equal(check(tree({ "src/a.ts": 'u = "dozo.example/x"' }), config).status, 0);
    assert.equal(check(tree({ "src/a.ts": 'u = "dozo.example/"' }), config).status, 0);
  });

  it("listFiles never descends into .git or node_modules, at any depth", () => {
    const root = tree({ "src/a.ts": "x", ".git/HEAD": "x", "node_modules/p/i.js": "x", "src/node_modules/q.js": "x", "src/.git/c": "x", "src/ok/b.ts": "x" });
    assert.deepEqual(listFiles(root), ["src/a.ts", "src/ok/b.ts"]);
  });
});

