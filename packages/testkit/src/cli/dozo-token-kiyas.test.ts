import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BenchCliIo } from "../evals/dozo-token-bench-report.js";

const mocks = vi.hoisted(() => ({
  cli: vi.fn<(args: readonly string[], io: BenchCliIo) => Promise<number>>(),
  bench: vi.fn(),
}));
vi.mock("../evals/dozo-token-bench-report.js", () => ({ runTokenBenchCli: mocks.cli }));
vi.mock("../evals/dozo-token-bench.js", () => ({ runTokenBench: mocks.bench }));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

it("hands the command line and the real file system to the benchmark, and exits with its code", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dozo-token-kiyas-"));
  dirs.push(dir);
  const present = path.join(dir, "baseline.json");
  writeFileSync(present, "{}");
  const argv = process.argv;
  process.argv = ["node", "dozo-token-kiyas.ts", present];
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  mocks.bench.mockResolvedValue({ tasks: [] });
  mocks.cli.mockImplementation(async (args, io) => {
    expect(args).toEqual([present]);
    expect(io.read(present)).toBe("{}");
    expect(io.read(path.join(dir, "missing.json"))).toBeUndefined();
    io.write(present, "new");
    io.log("line");
    expect(await io.run(undefined)).toEqual({ tasks: [] });
    return 3;
  });
  try {
    await import("./dozo-token-kiyas.js");
  } finally {
    process.argv = argv;
  }
  expect(process.exitCode).toBe(3);
  expect(readFileSync(present, "utf8")).toBe("new");
  expect(log).toHaveBeenCalledWith("line");
  expect(mocks.bench).toHaveBeenCalledOnce();
  log.mockRestore();
});
