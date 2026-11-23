import { beforeEach, describe, expect, it, vi } from "vitest";
import { lastingWriteCard } from "./dozo-lasting-write-card.js";
import type { RunContext } from "./run-context.js";
import type { ToolRequest } from "./run-tool-request.js";

// Reads the branded approvalDetailLength (dozo/brand/brand.json). Runs on the staged tree.

const current = vi.hoisted(() => ({ skill: undefined as Record<string, unknown> | undefined }));
vi.mock("./skill-tools.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  skillReadFromTool: vi.fn(async () => current.skill ?? { error: "Skill not found." }),
}));

const SECRET = "sk-test-secret-value";
const SKILL = "---\nname: Invoices\ndescription: Forward invoices\n---\n\nOld step.\n";

const ctx = {
  deps: { prisma: {} },
  run: { spaceId: "space-1", userId: "user-1" },
  secrets: [SECRET],
} as unknown as RunContext;

function card(name: string, args: Record<string, unknown>, held = true, replay = false) {
  return lastingWriteCard(
    ctx,
    { name, args, nextApprovedTool: replay ? name : undefined } as ToolRequest,
    held,
  );
}

const detail = async (name: string, args: Record<string, unknown>) =>
  (await card(name, args)).summary?.lines.join("\n");

beforeEach(() => {
  current.skill = {
    name: "Invoices",
    description: "Forward invoices",
    content: SKILL,
  };
});

describe("lastingWriteCard", () => {
  it("builds nothing for a write the rule did not hold, a delete, or the approved replay", async () => {
    expect(await card("skill_create", { name: "A" }, false)).toEqual({});
    expect(await card("skill_delete", { name: "A" })).toEqual({});
    expect(await card("schedule_create", { prompt: "x" }, true, true)).toEqual({});
  });

  it("asks once only, under the generic title with the tool's name in words", async () => {
    expect((await card("schedule_create", { prompt: "x" })).summary).toEqual({
      title: "Review before schedule create",
      lines: ["prompt: x"],
      onceOnly: true,
    });
    const titles: (string | undefined)[] = [];
    for (const name of ["skill_create", "skill_update", "schedule_update"])
      titles.push((await card(name, { name: "A" })).summary?.title);
    expect(titles).toEqual([
      "Review before skill create",
      "Review before skill update",
      "Review before schedule update",
    ]);
  });

  it("redacts secrets inside text, lists and objects, short values first", async () => {
    expect(
      await detail("schedule_create", {
        prompt: `Use ${SECRET}`,
        watch: { kind: "tool", tool: "lookup", args: { key: SECRET } },
        tags: [SECRET, "b"],
        timezone: "",
        every: 2,
      }),
    ).toBe(
      [
        'watch: {"kind":"tool","tool":"lookup","args":{"key":"[redacted]"}}',
        'tags: ["[redacted]","b"]',
        "every: 2",
        "prompt: Use [redacted]",
      ].join("\n"),
    );
  });

  it("shows a skill update that replaces the whole SKILL.md as a diff", async () => {
    const content = "---\nname: Invoices\ndescription: Forward invoices\n---\n\nNew step.\n";
    const shown = await detail("skill_update", { name: "Invoices", content });
    expect(shown).toContain("\n- Old step.");
    expect(shown).toContain("\n+ New step.");
    expect(shown?.startsWith("name: Invoices\n- ---")).toBe(true);
  });

  it("keeps the current description and name when the update leaves them out", async () => {
    const shown = await detail("skill_update", { skillId: "skill-1", body: "New step." });
    expect(shown).toContain("+ description: Forward invoices");
    expect(shown).toContain("+ name: Invoices");
  });

  it("shows the arguments in full when the update would be refused", async () => {
    // A replacement without frontmatter, a rename past the name limit.
    expect(await detail("skill_update", { name: "Invoices", content: "No frontmatter" })).toBe(
      "name: Invoices\ncontent: No frontmatter",
    );
    expect(await detail("skill_update", { name: "Invoices", newName: "n".repeat(81) })).toBe(
      `name: Invoices\nnewName: ${"n".repeat(81)}`,
    );
    current.skill = { name: "Invoices", description: "Forward invoices", content: "broken" };
    expect(await detail("skill_update", { name: "Invoices", body: "x" })).toBe(
      "name: Invoices\nbody: x",
    );
  });

  it("falls back to the new text when the diff is too long to show but the text is not", async () => {
    const old = "o".repeat(15_000);
    current.skill = {
      name: "Invoices",
      description: "Forward invoices",
      content: `---\nname: Invoices\ndescription: Forward invoices\n---\n\n${old}\n`,
    };
    const body = "n".repeat(15_000);
    expect(await detail("skill_update", { name: "Invoices", body })).toBe(
      `name: Invoices\nbody: ${body}`,
    );
  });

  it("refuses a text too long to show whole", async () => {
    expect(await card("schedule_update", { prompt: "x".repeat(20_501) })).toEqual({
      error: { error: "This is too long to show on the approval card; shorten it." },
    });
  });
});
