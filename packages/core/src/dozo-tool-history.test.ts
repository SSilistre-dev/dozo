import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { splitToolHistory, withToolHistory } from "./events.js";

// Through upstream's split (an anchored rule in dozo/brand/brand.json), on the branded tree: every
// message write keeps its tool calls with it for later runs to replay.

const PERSON = "Ada Example +90 555 010 2030";

function reply(tool: string, result: string, failed = false): MessageBlock[] {
  return [
    {
      kind: "steps",
      steps: [
        {
          label: tool,
          count: 1,
          tool,
          calls: [
            {
              arguments: JSON.stringify({ query: "Ada" }),
              result,
              ...(failed ? { failed: true as const } : {}),
            },
          ],
        },
      ],
    } as MessageBlock,
    { kind: "text", text: "Ada's number is in your contacts." },
  ];
}

describe("a reply's kept tool calls", () => {
  it.each(["phone_contacts_search", "phone_calendar_read", "phone_location"])(
    "keep no output of %s for a later run, only that it was read",
    (tool) => {
      const { blocks, toolHistory } = splitToolHistory(reply(tool, PERSON));
      expect(JSON.stringify(toolHistory)).not.toContain("+90");
      expect(toolHistory?.steps[0]).toEqual({
        tool,
        calls: [
          {
            arguments: JSON.stringify({ query: "Ada" }),
            result: "Read from the user's phone; not kept. Call the tool again to see it.",
          },
        ],
      });
      // What the person sees is unchanged, and a later run still gets the step and the reply.
      expect(blocks[1]).toEqual({ kind: "text", text: "Ada's number is in your contacts." });
      expect(withToolHistory(blocks, toolHistory)[0]).toMatchObject({
        steps: [{ tool, calls: [{ result: expect.stringContaining("not kept") }] }],
      });
    },
  );

  it("keeps an error, which holds no content, and every other tool's output as it was", () => {
    const failed = splitToolHistory(reply("phone_location", "Location is off.", true)).toolHistory;
    expect(failed?.steps[0]?.calls[0]).toMatchObject({ result: "Location is off.", failed: true });
    // A call without arguments keeps none.
    const bare = splitToolHistory([
      {
        kind: "steps",
        steps: [{ label: "x", count: 1, tool: "phone_location", calls: [{ result: PERSON }] }],
      } as MessageBlock,
    ]).toolHistory;
    expect(bare?.steps[0]?.calls).toEqual([
      { result: "Read from the user's phone; not kept. Call the tool again to see it." },
    ]);
    const other = splitToolHistory(reply("web_search", PERSON)).toolHistory;
    expect(other?.steps[0]?.calls[0]?.result).toBe(PERSON);
  });
});
