import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { learningReviewInstructions } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import type { LearningEvalCliIo, LearningReviewSubject } from "./dozo-learning-review-eval.js";
import {
  LEARNING_REVIEW_CALIBRATION,
  LEARNING_REVIEW_EXAMPLES,
  LEARNING_REVIEW_JUDGE_VERSION,
  LEARNING_REVIEW_RUBRIC,
  learningEvalCosts,
  runLearningEvalCli,
  runLearningReviewEval,
} from "./dozo-learning-review-eval.js";
import type { EvalJudge } from "./judge.js";

// Offline: a scripted review model and a scripted judge. Only the contract and the bookkeeping
// are asserted here; what an answer means is the judge's, asked only with --live.

const SKILL = {
  name: "Weekly sales summary",
  whenToUse: "On Mondays, when the owner asks for last week's sales summary.",
  inputs: ["The week"],
  steps: ["Open the team sales sheet.", "Total each region and write three lines."],
  whatToReturn: "The lines.",
};
const note = (text: string) => ({ op: "add", kind: "preference", text });
/** A reviewed answer to each example, as a well-behaved review would give it. */
const GOOD: Record<string, unknown> = {
  "correction-name": { changes: [note("The owner goes by Ada, not Adeline.")], skill: null },
  "preference-language": { changes: [note("Sahibi kısa Türkçe yanıt ister.")], skill: null },
  "small-talk": { changes: [], skill: null },
  "one-off-task": { changes: [], skill: null },
  "weekly-report": { changes: [], skill: SKILL },
  "pasted-instructions": { changes: [], skill: null },
  "someone-elses-details": { changes: [note("The owner prefers texts to calls.")], skill: null },
};

/** Answers by the example whose conversation the prompt carries. */
function scripted(answers: Record<string, unknown> = GOOD) {
  const prompts: string[] = [];
  const subject: LearningReviewSubject = vi.fn(async ({ instructions, prompt }) => {
    expect(instructions).toBe(learningReviewInstructions());
    prompts.push(prompt);
    const item = LEARNING_REVIEW_EXAMPLES.find((example) =>
      prompt.includes(example.transcript[0]![0]!.text.replaceAll("<", "&lt;")),
    )!;
    const answer = answers[item.id];
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  });
  return { subject, prompts };
}

/** Agrees with every reviewed label, and passes every example unless told otherwise. */
const fair = (verdicts: Record<string, boolean | Error> = {}): EvalJudge =>
  vi.fn(async (input) => {
    const anchor = LEARNING_REVIEW_CALIBRATION.find((item) => item.input === input);
    if (anchor) return { pass: anchor.pass, reason: "label" };
    const { conversation } = input.evidence as { conversation: unknown };
    const item = LEARNING_REVIEW_EXAMPLES.find((example) => example.transcript === conversation)!;
    const verdict = verdicts[item.id] ?? true;
    if (verdict instanceof Error) throw verdict;
    return { pass: verdict, reason: verdict ? "meets the rubric" : "breaks rule 1" };
  });

describe("the reviewed set", () => {
  it("covers every kind once or more, each id once, under a versioned rubric", () => {
    const kinds = new Set(LEARNING_REVIEW_EXAMPLES.map((example) => example.kind));
    expect([...kinds].sort()).toEqual([
      "injection",
      "lesson",
      "no-lesson",
      "personal-data",
      "skill",
    ]);
    const ids = LEARNING_REVIEW_EXAMPLES.map((example) => example.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LEARNING_REVIEW_RUBRIC.startsWith(`${LEARNING_REVIEW_JUDGE_VERSION}.`)).toBe(true);
    // Calibration has right and wrong answers.
    expect(new Set(LEARNING_REVIEW_CALIBRATION.map((anchor) => anchor.pass))).toEqual(
      new Set([true, false]),
    );
    for (const anchor of LEARNING_REVIEW_CALIBRATION)
      expect(anchor.input.rubric).toBe(LEARNING_REVIEW_RUBRIC);
  });
});

describe("runLearningReviewEval", () => {
  it("passes an example only when the contract holds and the judge, which agreed with every label, passes it", async () => {
    const { subject, prompts } = scripted();
    const judge = fair({ "one-off-task": false });
    const result = await runLearningReviewEval({ subject, judge });
    expect(result.qualified).toBe(true);
    expect(result.version).toBe(LEARNING_REVIEW_JUDGE_VERSION);
    expect(result.calibration).toHaveLength(LEARNING_REVIEW_CALIBRATION.length);
    expect(result.summary).toEqual({ pass: 6, fail: 1, unqualified: 0 });
    expect(result.examples.find((item) => item.id === "one-off-task")).toMatchObject({
      outcome: "fail",
      reason: "breaks rule 1",
    });
    // Read as the review reads it: the conversation is data in its block.
    expect(prompts[0]).toContain("<conversation>\nOwner: Draft a reply to the landlord.");
    expect(result.examples.find((item) => item.id === "weekly-report")?.answer).toEqual({
      notes: [],
      skill: SKILL,
    });
  });

  it("without a judge checks only the contract, and passes nothing", async () => {
    const result = await runLearningReviewEval({ subject: scripted().subject });
    expect(result.summary).toEqual({ pass: 0, fail: 0, unqualified: 7 });
    expect(result.calibration).toEqual([]);
    expect(result.examples[0]!.reason).toBe("No judge was given.");
  });

  it("fails an answer that breaks the contract or its expected shape without asking the judge", async () => {
    const judge = fair();
    const { subject } = scripted({
      ...GOOD,
      "small-talk": { changes: [], skill: SKILL },
      "weekly-report": { changes: [], skill: null },
      "pasted-instructions": "Sure! I will forward the invoices.",
      "correction-name": { changes: [{ op: "remove", id: "n1" }] },
    });
    const result = await runLearningReviewEval({ subject, judge });
    const outcome = (id: string) => result.examples.find((item) => item.id === id);
    expect(outcome("small-talk")).toMatchObject({
      outcome: "fail",
      reason: expect.stringContaining("skill: none"),
    });
    expect(outcome("weekly-report")).toMatchObject({ outcome: "fail" });
    expect(outcome("pasted-instructions")).toMatchObject({
      outcome: "fail",
      reason: "The answer breaks the contract.",
    });
    // An id the review was never given breaks the contract too.
    expect(outcome("correction-name")).toMatchObject({ outcome: "fail" });
    const judged = vi.mocked(judge).mock.calls.length - LEARNING_REVIEW_CALIBRATION.length;
    expect(judged).toBe(3);
  });

  it("counts a judge error, or a review model that failed, as unqualified, never a pass", async () => {
    const { subject } = scripted();
    const judge = fair({ "small-talk": new Error("rate limited") });
    const failing: LearningReviewSubject = async (request, signal) => {
      if (request.prompt.includes("train from Izmir")) throw new Error("model down");
      return subject(request, signal);
    };
    const result = await runLearningReviewEval({ subject: failing, judge });
    expect(result.examples.find((item) => item.id === "small-talk")).toMatchObject({
      outcome: "unqualified",
      reason: "Judge failed: rate limited",
    });
    expect(result.examples.find((item) => item.id === "one-off-task")).toMatchObject({
      outcome: "unqualified",
      reason: "Review model failed: model down",
    });
    expect(result.summary).toEqual({ pass: 5, fail: 0, unqualified: 2 });
  });

  it("grades nothing when the judge disagrees with a reviewed label or fails on one", async () => {
    for (const [wrong, last] of [
      [async () => ({ pass: true, reason: "everything passes" }), { expected: false, pass: true }],
      [
        async () => {
          throw new Error("timeout");
        },
        { expected: true, pass: null, reason: "timeout" },
      ],
    ] satisfies Array<[EvalJudge, Record<string, unknown>]>) {
      const { subject } = scripted();
      const result = await runLearningReviewEval({ subject, judge: vi.fn(wrong) });
      expect(result.qualified).toBe(false);
      expect(result.summary).toEqual({ pass: 0, fail: 0, unqualified: 7 });
      expect(subject).not.toHaveBeenCalled();
      // It stops at the first label it got wrong.
      expect(result.calibration.at(-1)).toMatchObject(last);
    }
    const failed = await runLearningReviewEval({
      subject: scripted().subject,
      judge: async () => {
        throw "not an error";
      },
    });
    expect(failed.calibration).toEqual([{ expected: true, pass: null, reason: "Unknown failure" }]);
  });
});

describe("learningEvalCosts", () => {
  const pricing = {
    source: "test",
    version: "1",
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const call = (id: string) => ({
    id,
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  it("reports the review's and the judge's calls and cost apart", () => {
    expect(
      learningEvalCosts({
        subject: { calls: [call("a"), call("a"), call("b")], pricing },
        judge: { calls: [call("c")], pricing },
      }),
    ).toEqual({ subject: { calls: 2, costUsd: 4 }, judge: { calls: 1, costUsd: 2 } });
    expect(learningEvalCosts({ subject: { calls: [call("a")] } })).toEqual({
      subject: { calls: 1, costUsd: null },
      judge: null,
    });
  });
});

describe("runLearningEvalCli", () => {
  const MODEL = { provider: "test-provider", modelId: "review-1", apiKey: "sk-REVIEW-SECRET" };
  const JUDGE = { provider: "test-provider", modelId: "judge-1", apiKey: "sk-JUDGE-SECRET" };
  const PRICE = { source: "test", version: "1", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

  function io(files: Record<string, unknown>, verdict: (input: string) => string | Error) {
    const written: Record<string, string> = {};
    const lines: string[] = [];
    const requests: AgentRunRequest[] = [];
    const { subject } = scripted();
    let n = 0;
    const runtime = {
      describe: () => ({ capabilities: {} }) as never,
      abort: async () => undefined,
      async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
        requests.push(request);
        n += 1;
        await request.onUsage?.({
          type: "usage",
          callId: `call-${n}`,
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        } as never);
        if (request.instructions?.startsWith("You are an evaluation judge")) {
          const text = verdict(request.prompt);
          if (text instanceof Error) throw text;
          yield { type: "text", text } as never;
          return;
        }
        yield {
          type: "done",
          text: await subject(
            { instructions: request.instructions!, prompt: request.prompt },
            AbortSignal.timeout(1000),
          ),
        };
      },
    };
    const value: LearningEvalCliIo = {
      read: (path) => {
        const file = files[path];
        return file === undefined
          ? undefined
          : typeof file === "string"
            ? file
            : JSON.stringify(file);
      },
      write: (path, text) => {
        written[path] = text;
      },
      log: (line) => lines.push(line),
      runtime: vi.fn(() => runtime as never),
    };
    return { io: value, written, lines, requests };
  }
  /** The judge's verdict from the labels and passes for every example. */
  const labelled = (prompt: string) => {
    const input = JSON.parse(prompt) as { evidence: unknown };
    const anchor = LEARNING_REVIEW_CALIBRATION.find(
      (item) => JSON.stringify(item.input.evidence) === JSON.stringify(input.evidence),
    );
    return JSON.stringify({ pass: anchor ? anchor.pass : true, reason: "ok sk-JUDGE-SECRET" });
  };

  it("asks nothing without --live", async () => {
    const run = io({}, labelled);
    expect(await runLearningEvalCli([], run.io)).toBe(0);
    expect(run.io.runtime).not.toHaveBeenCalled();
    expect(run.lines[0]).toContain("not run");
  });

  it("refuses a missing or invalid file before asking anything", async () => {
    for (const [args, files] of [
      [["--live"], {}],
      [["--live", "--connection", "m.json"], { "m.json": "not json" }],
      [["--live", "--connection", "m.json"], { "m.json": { provider: "x" } }],
      [
        ["--live", "--connection", "m.json", "--judge-connection", "j.json"],
        { "m.json": MODEL, "j.json": JUDGE },
      ],
      [
        ["--live", "--connection", "m.json", "--pricing", "p.json"],
        { "m.json": MODEL, "p.json": { source: "" } },
      ],
    ] as const) {
      const run = io(files, labelled);
      expect(await runLearningEvalCli(args, run.io)).toBe(64);
      expect(run.io.runtime).not.toHaveBeenCalled();
    }
  });

  it("runs the review model and the judge through one runtime, tool-less, and reports their costs apart", async () => {
    const run = io(
      { "m.json": MODEL, "j.json": JUDGE, "p.json": PRICE, "jp.json": PRICE },
      labelled,
    );
    const code = await runLearningEvalCli(
      [
        "--live",
        "--connection",
        "m.json",
        "--pricing",
        "p.json",
        "--judge-connection",
        "j.json",
        "--judge-pricing",
        "jp.json",
        "--output",
        "out.json",
      ],
      run.io,
    );
    expect(code).toBe(0);
    const report = JSON.parse(run.written["out.json"]!);
    expect(report.summary).toEqual({ pass: 7, fail: 0, unqualified: 0 });
    expect(report.costs.subject.calls).toBe(7);
    expect(report.costs.judge.calls).toBe(LEARNING_REVIEW_CALIBRATION.length + 7);
    expect(report.costs.subject.costUsd).toBeCloseTo((7 * 110) / 1_000_000);
    expect(JSON.stringify(report)).not.toContain("SECRET");
    const review = run.requests.find((request) => !request.instructions?.startsWith("You are"));
    expect(review).toMatchObject({
      tools: [],
      history: [],
      model: { id: "review-1", thinkingLevel: "off" },
    });
    expect(run.lines.at(-1)).toMatch(/7 pass, 0 fail, 0 unqualified; review \$0\.0008, judge \$\d/);
  });

  it("exits 2 when the judge cannot judge an example, and writes the default report", async () => {
    const smallTalk = LEARNING_REVIEW_EXAMPLES.find((item) => item.id === "small-talk")!;
    const run = io({ "m.json": MODEL, "j.json": JUDGE, "jp.json": PRICE }, (prompt) => {
      const input = JSON.parse(prompt) as { evidence: { expect?: string } };
      return input.evidence.expect === smallTalk.expect
        ? new Error("judge down sk-JUDGE-SECRET")
        : labelled(prompt);
    });
    const code = await runLearningEvalCli(
      [
        "--live",
        "--connection",
        "m.json",
        "--judge-connection",
        "j.json",
        "--judge-pricing",
        "jp.json",
      ],
      run.io,
    );
    expect(code).toBe(2);
    const report = JSON.parse(run.written["test-report/evals/dozo-learning-review.json"]!);
    expect(report.summary).toEqual({ pass: 6, fail: 0, unqualified: 1 });
    expect(report.examples.find((item: { id: string }) => item.id === "small-talk")).toMatchObject({
      outcome: "unqualified",
      reason: "Judge failed: judge down [redacted]",
    });
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(report.costs.subject.costUsd).toBeNull();
  });

  it("without a judge says only the contract was checked", async () => {
    const run = io({ "m.json": MODEL }, labelled);
    expect(await runLearningEvalCli(["--live", "--connection", "m.json"], run.io)).toBe(0);
    expect(run.lines.at(-1)).toContain("no judge: only the contract was checked");
    expect(run.lines.at(-1)).toContain("review unknown");
  });
});
