import type { HistoryToolStep, MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { splitToolHistory, withToolHistory } from "./events.js";

// Through upstream's split (an anchored rule in dozo/brand/brand.json), on the branded tree: every
// message write keeps its tool calls with it for later runs to replay.

const PERSON = "Ada Example +90 555 010 2030";

function reply(tool: string, result: string, failed = false): MessageBlock[] {
  const step: HistoryToolStep = {
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
  };
  return [
    { kind: "steps", steps: [step] },
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
    const bareStep: HistoryToolStep = {
      label: "x",
      count: 1,
      tool: "phone_location",
      calls: [{ result: PERSON }],
    };
    const bare = splitToolHistory([{ kind: "steps", steps: [bareStep] }]).toolHistory;
    expect(bare?.steps[0]?.calls).toEqual([
      { result: "Read from the user's phone; not kept. Call the tool again to see it." },
    ]);
    const other = splitToolHistory(reply("web_search", PERSON)).toolHistory;
    expect(other?.steps[0]?.calls[0]?.result).toBe(PERSON);
  });
});

describe("a reply's kept writes to the phone", () => {
  const TITLE = "Dentist with Dr. Example";
  const NOTES = "Bring the referral letter";
  const write = (tool: string, failed = false) => {
    // A step as the run writes it, with its tool and calls (HistoryToolStep).
    const step = {
      label: tool,
      count: 1,
      tool,
      calls: [
        {
          arguments: JSON.stringify({ title: TITLE, notes: NOTES }),
          result: failed ? "Add to calendar is off." : JSON.stringify({ created: true }),
          ...(failed ? { failed: true as const } : {}),
        },
      ],
    };
    return [{ kind: "steps", steps: [step] } as MessageBlock];
  };

  it.each(["phone_calendar_create", "phone_reminder_create"])(
    "keep neither what %s wrote nor its arguments, only that it was written",
    (tool) => {
      const { toolHistory } = splitToolHistory(write(tool));
      expect(toolHistory?.steps[0]).toEqual({
        tool,
        calls: [{ result: "Written to the user's phone." }],
      });
      const failed = splitToolHistory(write(tool, true)).toolHistory;
      expect(failed?.steps[0]?.calls).toEqual([
        { result: "Add to calendar is off.", failed: true },
      ]);
      for (const text of [TITLE, NOTES])
        expect(JSON.stringify([toolHistory, failed])).not.toContain(text);
    },
  );

  it("keeps a reminders read's output out too", () => {
    const { toolHistory } = splitToolHistory(reply("phone_reminders_read", PERSON));
    expect(JSON.stringify(toolHistory)).not.toContain("+90");
  });
});
