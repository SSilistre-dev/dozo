import type { CliModelDriver, CliUsageLimit } from "../dozo-cli-driver.js";
import { CLAUDE_CODE_COMMAND, claudeCodeEnv } from "./cli.js";
import { claudeCodeModel } from "./provider.js";
import { CLAUDE_CODE_PROVIDER_ID } from "./provider-id.js";

/** A reset further away than this is not a reset time the CLI meant. */
const MAX_RESET_MS = 31 * 24 * 60 * 60_000;

/**
 * A `rate_limit_event` whose `rate_limit_info.status` is `rejected`: the account hit its limit.
 * `resetsAt` is in epoch seconds; a value that is not a plausible future time is left out.
 */
function rejectedLimit(event: Record<string, unknown>): CliUsageLimit | undefined {
  if (event.type !== "rate_limit_event") return undefined;
  const info = event.rate_limit_info as { status?: unknown; resetsAt?: unknown } | undefined;
  if (info?.status !== "rejected") return undefined;
  const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : Number.NaN;
  const ahead = resetsAt - Date.now();
  return ahead > 0 && ahead < MAX_RESET_MS ? { resetsAt } : {};
}

/**
 * Claude Code on the person's own computer. `CLAUDE_CONFIG_DIR` is its documented home folder
 * setting; only `loggedIn` is read from `claude auth status --json`; `claude auth login` is its own
 * sign-in, which prints the address to open.
 */
export const claudeCodeDriver: CliModelDriver = {
  provider: CLAUDE_CODE_PROVIDER_ID,
  name: "Claude Code",
  command: CLAUDE_CODE_COMMAND,
  homeEnv: "CLAUDE_CONFIG_DIR",
  args: {
    version: ["--version"],
    status: ["auth", "status", "--json"],
    login: ["auth", "login"],
    logout: ["auth", "logout"],
  },
  loginHosts: ["claude.ai", "claude.com", "anthropic.com"],
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
  usageLimit: rejectedLimit,
  models: (models) =>
    models.getModels("anthropic").map((model) => claudeCodeModel(model.id, models)),
  async stream(model, context, options) {
    const { streamClaudeCode } = await import("./stream.js");
    return streamClaudeCode(model, context, options);
  },
};
