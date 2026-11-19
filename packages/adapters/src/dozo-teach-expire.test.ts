import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("./teaching-session.js", () => ({
  expireTaughtSkillTeaching: vi.fn(async (_deps: unknown, skillId: string) => {
    calls.push(`upstream ${skillId}`);
    return { id: skillId };
  }),
}));
vi.mock("@rakazo/db", () => ({
  expireTeachValues: vi.fn(async (_prisma: unknown, skillId: string) => {
    calls.push(`values ${skillId}`);
  }),
}));

const { expireTaughtSkillTeaching } = await import("./dozo-teach-expire.js");

describe("expireTaughtSkillTeaching", () => {
  it("runs upstream's timer, then forgets the skill's values once due", async () => {
    const prisma = {};
    expect(await expireTaughtSkillTeaching({ prisma } as never, "skill-1")).toEqual({
      id: "skill-1",
    });
    expect(calls).toEqual(["upstream skill-1", "values skill-1"]);
  });
});
