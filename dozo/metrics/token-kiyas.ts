// Entry point of make token-kiyas (run by dozo/metrics/token-kiyas.sh inside Docker).
import { readFileSync, writeFileSync } from "node:fs";
import { runTokenBench } from "../../packages/testkit/src/evals/dozo-token-bench.js";
import { runTokenBenchCli } from "../../packages/testkit/src/evals/dozo-token-bench-report.js";
import { TOKEN_BENCH_TASKS } from "../../packages/testkit/src/evals/dozo-token-bench-tasks.js";

process.exitCode = await runTokenBenchCli(process.argv.slice(2), {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  write: (path, text) => writeFileSync(path, text),
  log: (line) => console.log(line),
  run: (pricing) => runTokenBench(TOKEN_BENCH_TASKS, pricing),
});
