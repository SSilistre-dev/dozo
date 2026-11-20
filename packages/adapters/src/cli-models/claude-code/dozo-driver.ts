import type { CliModelDriver } from "../dozo-cli-driver.js";
import { CLAUDE_CODE_COMMAND, claudeCodeEnv } from "./cli.js";
import { claudeCodeModel } from "./provider.js";
import { CLAUDE_CODE_PROVIDER_ID } from "./provider-id.js";

/**
 * Claude Code on the person's own computer. `CLAUDE_CONFIG_DIR` is its documented home folder
 * setting; only `loggedIn` is read from `claude auth status --json`.
 */
export const claudeCodeDriver: CliModelDriver = {
  provider: CLAUDE_CODE_PROVIDER_ID,
  name: "Claude Code",
  command: CLAUDE_CODE_COMMAND,
  homeEnv: "CLAUDE_CONFIG_DIR",
  args: { version: ["--version"], status: ["auth", "status", "--json"] },
  env: (source) => claudeCodeEnv(source),
  modelSource: "anthropic",
  signedIn(stdout) {
    try {
      const loggedIn: unknown = (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn;
      return typeof loggedIn === "boolean" ? loggedIn : undefined;
    } catch {
      return undefined;
    }
  },
  models: (models) =>
    models.getModels("anthropic").map((model) => claudeCodeModel(model.id, models)),
  async stream(model, context, options) {
    const { streamClaudeCode } = await import("./stream.js");
    return streamClaudeCode(model, context, options);
  },
};
