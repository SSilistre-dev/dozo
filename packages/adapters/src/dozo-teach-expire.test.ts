import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const upstream = vi.hoisted(() =>
  vi.fn(async (_deps: unknown, skillId: string): Promise<unknown> => {
    calls.push(`upstream ${skillId}`);
    return { id: skillId };
  }),
);
vi.mock("./teaching-session.js", () => ({ expireTaughtSkillTeaching: upstream }));
vi.mock("@rakazo/db", () => ({
  expireTeachValues: vi.fn(async (_prisma: unknown, skillId: string) => {
    calls.push(`values ${skillId}`);
  }),
}));

const { expireTaughtSkillTeaching } = await import("./dozo-teach-expire.js");

describe("expireTaughtSkillTeaching", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("forgets the skill's values once due, then runs upstream's timer", async () => {
    const prisma = {};
    expect(await expireTaughtSkillTeaching({ prisma } as never, "skill-1")).toEqual({
      id: "skill-1",
    });
    expect(calls).toEqual(["values skill-1", "upstream skill-1"]);
  });

  it("has forgotten the values when upstream's part fails", async () => {
    upstream.mockRejectedValueOnce(new Error("sandbox down"));
    await expect(expireTaughtSkillTeaching({ prisma: {} } as never, "skill-2")).rejects.toThrow(
      "sandbox down",
    );
    expect(calls).toEqual(["values skill-2"]);
  });
});
