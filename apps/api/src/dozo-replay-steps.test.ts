import type { MessageBlock, ToolHistory } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { framesLeftOut, replaySteps } from "./dozo-replay-steps.js";

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

describe("replaySteps", () => {
  it("shows the step's label and the address's host, never its path, query or other input", () => {
    const [step] = replaySteps(
      steps("Browser act"),
      history({
        tool: "browser_act",
        arguments: JSON.stringify({
          kind: "type",
          text: "my typed words",
          page: { url: "https://news.example.test/a/b?q=private#frag" },
        }),
      }),
    );
    expect(step).toEqual({ line: "Browser act · news.example.test", sensitive: false });
  });

  it("keeps a step's screenshot by its artifact, and a step with no kept calls by label only", () => {
    expect(
      replaySteps(steps("Screenshot", "Gmail send email"), {
        steps: [{ tool: "screenshot", calls: [{ image: { artifactId: "a1" } }] }, null],
      }),
    ).toEqual([
      { line: "Screenshot", frameArtifactId: "a1", sensitive: false },
      { line: "Gmail send email", sensitive: false },
    ]);
  });

  it.each([
    ["a saved login typed in", { tool: "browser_act", arguments: '{"kind":"fill_secret"}' }],
    ["a card typed in", { tool: "browser_act", arguments: '{"kind":"fill_card"}' }],
    ["a sign-in page", { tool: "browser_navigate", arguments: '{"url":"https://x.test/login"}' }],
    ["a checkout page", { tool: "browser_navigate", arguments: '{"url":"https://x.test/checkout"}' }],
    ["a secret tool", { tool: "request_secret" }],
  ])("marks %s as sensitive", (_name, call) => {
    expect(replaySteps(steps("Step"), history(call))[0]?.sensitive).toBe(true);
  });

  it("marks a step on a site the bot's browser is signed in to as sensitive", () => {
    const call = { tool: "browser_navigate", arguments: '{"url":"https://mail.example.test/"}' };
    expect(replaySteps(steps("Open"), history(call), ["example.test"])[0]?.sensitive).toBe(true);
    expect(replaySteps(steps("Open"), history(call), ["other.test"])[0]?.sensitive).toBe(false);
  });
});

describe("framesLeftOut", () => {
  it("leaves out every screenshot from the first sensitive step on", () => {
    const step = (sensitive: boolean) => ({ line: "s", sensitive });
    expect(framesLeftOut([step(false), step(true), step(false)])).toEqual([false, true, true]);
  });
});
