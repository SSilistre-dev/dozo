import type { MessageBlock, ToolHistory } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  framesStartLeftOut,
  parseToolHistory,
  publicHost,
  replayFingerprint,
  replaySteps,
} from "./dozo-replay-steps.js";

const steps = (...labels: string[]): MessageBlock[] => [
  { kind: "steps", steps: labels.map((label) => ({ label, count: 1 })) },
];
const history = (...calls: Array<{ tool: string; arguments?: string; shot?: string }>) =>
  ({
    steps: calls.map(({ tool, arguments: args, shot }) => ({
      tool,
      calls: [{ arguments: args, ...(shot ? { image: { artifactId: shot } } : {}) }],
    })),
  }) satisfies ToolHistory;
const open = (url: string) => ({ tool: "browser_navigate", arguments: JSON.stringify({ url }) });
const lineOf = (url: string) => replaySteps(steps("Browser navigate"), history(open(url)))[0]?.line;

describe("a step's line", () => {
  it("shows the opened page's host, never its path, query or fragment", () => {
    expect(lineOf("https://news.example.com/a/b?q=private#frag")).toBe(
      "Browser navigate · news.example.com",
    );
  });

  it("reads a host only from the page a navigation opened, never from typed text", () => {
    const typed = {
      tool: "browser_act",
      arguments: JSON.stringify({
        actions: [{ kind: "type", text: "https://typed.example.com/" }],
      }),
    };
    expect(replaySteps(steps("Browser act"), history(typed))[0]?.line).toBe("Browser act");
  });

  it.each([
    ["an IPv4 address", "http://10.0.0.5:8080/a?b"],
    ["an IPv6 address", "http://[::1]/"],
    ["loopback", "http://localhost:3000/"],
    ["a name without a dot", "http://intranet/"],
    ["an internal name", "https://preview.cluster.internal/"],
    ["a local name", "http://printer.local/"],
    ["a reserved test name", "https://shop.example.test/"],
    ["a home network name", "http://router.home.arpa/"],
  ])("leaves out %s", (_name, url) => {
    expect(lineOf(url)).toBe("Browser navigate");
  });

  it("keeps a name in another script in its xn-- form", () => {
    expect(lineOf("https://bücher.example.com/")).toBe(
      "Browser navigate · xn--bcher-kva.example.com",
    );
  });

  it("leaves out a host that would run past the line's limit", () => {
    expect(publicHost(new URL(`https://${"a".repeat(60)}.${"b".repeat(60)}.com/`), 117)).toBe(
      undefined,
    );
    expect(publicHost(new URL("https://shop.example.com/"), 117)).toBe("shop.example.com");
  });

  it("names a tool that is not built in generically, kept or not", () => {
    expect(
      replaySteps(steps("Acme crm export"), history({ tool: "acme_crm_export" }))[0]?.line,
    ).toBe("Action");
    expect(
      replaySteps(steps("Acme crm export", "Web search"), { steps: [null, null] }),
    ).toMatchObject([{ line: "Action" }, { line: "Web search" }]);
  });

  it("keeps a step's screenshot by its artifact, and marks a step whose calls were not kept", () => {
    expect(
      replaySteps(steps("Browser snapshot", "Web search"), {
        steps: [{ tool: "browser_snapshot", calls: [{ image: { artifactId: "a1" } }] }, null],
      }),
    ).toEqual([
      {
        line: "Browser snapshot",
        frameArtifactId: "a1",
        sensitive: false,
        classified: true,
        stored: "Browser snapshot",
      },
      { line: "Web search", sensitive: false, classified: false, stored: "Web search" },
    ]);
  });
});

describe("a sensitive step", () => {
  it.each([
    [
      "a saved login typed in",
      { tool: "browser_act", arguments: '{"actions":[{"kind":"fill_secret"}]}' },
    ],
    ["a card typed in", { tool: "browser_act", arguments: '{"actions":[{"kind":"fill_card"}]}' }],
    [
      "plain typing",
      { tool: "browser_act", arguments: '{"actions":[{"kind":"type","ref":"e1"}]}' },
    ],
    [
      "desktop typing",
      { tool: "computer_act", arguments: '{"actions":[{"action":"type","text":"hi"}]}' },
    ],
    ["a sign-in page", open("https://x.example.com/login")],
    ["a sign-in in the query", open("https://x.example.com/?action=login")],
    ["a checkout behind a hash route", open("https://x.example.com/#/checkout")],
    ["a secret tool", { tool: "request_secret" }],
  ])("is %s", (_name, call) => {
    expect(replaySteps(steps("Step"), history(call))[0]?.sensitive).toBe(true);
  });

  it("is a page on a site the bot's browser is signed in to", () => {
    const call = open("https://mail.example.com/");
    expect(replaySteps(steps("Open"), history(call), ["example.com"])[0]?.sensitive).toBe(true);
    expect(replaySteps(steps("Open"), history(call), ["other.com"])[0]?.sensitive).toBe(false);
  });

  it("is every browser step while the signed-in sites cannot be read", () => {
    const read = replaySteps(
      steps("Browser navigate", "Web search"),
      history(open("https://mail.example.com/"), { tool: "web_search" }),
      null,
    );
    expect(read.map((step) => step.sensitive)).toEqual([true, false]);
  });
});

describe("framesStartLeftOut", () => {
  const step = (sensitive: boolean, classified = true) => ({
    line: "s",
    sensitive,
    classified,
    stored: "s",
  });

  it("leaves every screenshot out when any step is sensitive or could not be read", () => {
    expect(framesStartLeftOut([step(false), step(false)])).toBe(false);
    expect(framesStartLeftOut([step(false), step(true)])).toBe(true);
    expect(framesStartLeftOut([step(false, false)])).toBe(true);
  });
});

describe("replayFingerprint", () => {
  it("changes when a line or a chosen screenshot changes, and only then", () => {
    const search = { line: "Web search", stored: "Web search" };
    const shot = { line: "Browser snapshot", stored: "Browser snapshot", frameArtifactId: "a1" };
    expect(replayFingerprint([search, shot])).toBe(replayFingerprint([{ ...search }, { ...shot }]));
    expect(replayFingerprint([search, shot])).not.toBe(
      replayFingerprint([{ line: "Action", stored: "Acme" }, search, shot]),
    );
    expect(replayFingerprint([search, shot])).not.toBe(
      replayFingerprint([search, { ...shot, frameArtifactId: undefined }]),
    );
    expect(replayFingerprint([search, shot])).not.toBe(
      replayFingerprint([{ ...search, stored: "Send email" }, shot]),
    );
  });
});

describe("parseToolHistory", () => {
  it("reads nothing from no history, broken JSON, or another shape", () => {
    expect(parseToolHistory(null)).toBeUndefined();
    expect(parseToolHistory("{")).toBeUndefined();
    expect(parseToolHistory('{"steps":"no"}')).toBeUndefined();
    expect(parseToolHistory('{"steps":[null]}')).toEqual({ steps: [null] });
  });

  it("finds no host in arguments that are not JSON", () => {
    expect(
      replaySteps(
        steps("Browser navigate"),
        history({ tool: "browser_navigate", arguments: "x" }),
      )[0]?.line,
    ).toBe("Browser navigate");
  });
});
