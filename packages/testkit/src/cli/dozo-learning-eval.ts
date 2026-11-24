// The judged evaluation of the bot learning review's prompt (dozo/README.md, Bot learning). Asks
// models only with --live; see runLearningEvalCli for the options.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PiAgentRuntime } from "@rakazo/adapters";
import { runLearningEvalCli } from "../evals/dozo-learning-review-eval.js";

process.exitCode = await runLearningEvalCli(process.argv.slice(2), {
  read: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  write: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  },
  log: (line) => console.log(line),
  runtime: () => new PiAgentRuntime({}),
});
