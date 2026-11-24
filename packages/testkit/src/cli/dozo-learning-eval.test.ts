import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LearningEvalCliIo } from "../evals/dozo-learning-review-eval.js";

const mocks = vi.hoisted(() => ({
  cli: vi.fn<(args: readonly string[], io: LearningEvalCliIo) => Promise<number>>(),
  runtime: vi.fn(),
}));
vi.mock("../evals/dozo-learning-review-eval.js", () => ({ runLearningEvalCli: mocks.cli }));
vi.mock("@rakazo/adapters", () => ({
  PiAgentRuntime: class {
    constructor() {
      mocks.runtime();
    }
  },
}));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

it("hands the command line, the real file system and the runtime to the evaluation, and exits with its code", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dozo-learning-eval-"));
  dirs.push(dir);
  const present = path.join(dir, "model.json");
  writeFileSync(present, "{}");
  const report = path.join(dir, "nested", "report.json");
  const argv = process.argv;
  process.argv = ["node", "dozo-learning-eval.ts", "--live"];
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  mocks.cli.mockImplementation(async (args, io) => {
    expect(args).toEqual(["--live"]);
    expect(io.read(present)).toBe("{}");
    expect(io.read(path.join(dir, "missing.json"))).toBeUndefined();
    io.write(report, "written");
    io.log("line");
    io.runtime();
    return 2;
  });
  try {
    await import("./dozo-learning-eval.js");
  } finally {
    process.argv = argv;
  }
  expect(process.exitCode).toBe(2);
  expect(readFileSync(report, "utf8")).toBe("written");
  expect(log).toHaveBeenCalledWith("line");
  expect(mocks.runtime).toHaveBeenCalledOnce();
  log.mockRestore();
});
