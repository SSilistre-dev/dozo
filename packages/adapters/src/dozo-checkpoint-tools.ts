import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { partitionTools } from "./builtin-tool-bridge.js";
import type { ToolHost } from "./pi-runtime-tools.js";
import { toAgentTool } from "./pi-runtime-tools.js";

/**
 * A paused turn may hold a direct call to a built-in that was listed when it paused and is now
 * reached through find_tool, such as a schedule_create waiting for approval across a deploy.
 * When this run still offers that built-in, the call resumes on it as it was made; a tool the run
 * no longer offers stays unavailable.
 */
export function restoredDeferredTool(
  toolDefs: readonly ConnectorTool[],
  host: ToolHost,
  name: string,
): AgentTool | undefined {
  const tool = partitionTools(toolDefs).deferred.find((candidate) => candidate.name === name);
  return tool && toAgentTool(tool, host, tool.name);
}
