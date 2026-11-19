import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin.tool-definition.js";
import { partitionTools } from "./builtin-tool-bridge.js";

describe("built-ins listed to the model", () => {
  const { listed, deferred } = partitionTools(builtinAgentTools);
  const names = (tools: typeof listed) => tools.map((tool) => tool.name);

  it("defer the schedule tools, which every run is offered and few turns use", () => {
    expect(names(deferred)).toEqual(expect.arrayContaining(["schedule_create", "schedule_list"]));
    expect(names(listed)).not.toContain("schedule_create");
    expect(names(listed)).toEqual(expect.arrayContaining(["find_tool", "use_tool"]));
  });

  it("keep the tools the runtime answers itself and the inbox tools listed", () => {
    expect(names(listed)).toEqual(
      expect.arrayContaining(["request_secret", "update_bot", "read_email", "send_email"]),
    );
  });
});
