import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const mocks = vi.hoisted(() => ({
  expire: vi.fn(async (_deps: unknown, id: string): Promise<unknown> => {
    calls.push(`draft ${id}`);
    return null;
  }),
  forget: vi.fn(
    async (): Promise<{ looked: number; last: string | null }> => ({
      looked: 0,
      last: null,
    }),
  ),
  system: vi.fn(async (_reason: string, work: () => Promise<unknown>) => work()),
}));
vi.mock("@rakazo/adapters", () => ({ expireTaughtSkillTeaching: mocks.expire }));
vi.mock("@rakazo/db", () => ({
  runAsSystem: mocks.system,
  expireAllTeachValues: vi.fn(async () => {
    calls.push("values");
    return 0;
  }),
}));
vi.mock("./dozo-taught-skills.js", () => ({ FORGET_PAGE: 2, forgetOldTeachTyping: mocks.forget }));

const { dozoTeachSweep } = await import("./dozo-teach-sweep.js");

function sweep(late: string[]) {
  const queryRaw = vi.fn(async () => late.map((id) => ({ id })));
  const deps = { prisma: { $queryRaw: queryRaw } };
  return { run: dozoTeachSweep(deps as never), queryRaw, deps };
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe("dozoTeachSweep", () => {
  it("as system: forgets due values, drafts late recordings and forgets old typing", async () => {
    mocks.expire.mockRejectedValueOnce(new Error("sandbox down"));
    mocks.forget.mockImplementation(async () => {
      calls.push("forget");
      const page = calls.filter((call) => call === "forget").length;
      return page < 3 ? { looked: 2, last: `id-${page}` } : { looked: 1, last: "id-3" };
    });
    const { run, queryRaw, deps } = sweep(["a", "b"]);
    await run(new AbortController().signal);
    expect(mocks.system).toHaveBeenCalledWith(
      "sweep what teaching left behind",
      expect.any(Function),
    );
    // One recording that cannot be drafted does not hold back the others.
    expect(calls).toEqual(["values", "draft b", "forget", "forget", "forget"]);
    expect(mocks.expire).toHaveBeenCalledWith(deps, "a");
    const [strings, seconds] = queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, number];
    expect(strings.join("?")).toContain("status = 'recording'");
    expect(seconds).toBe(600);
    // Each page goes on past the last skill the one before looked at, broken ones included.
    expect(mocks.forget.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { after: undefined },
      { after: "id-1" },
      { after: "id-2" },
    ]);
    expect(mocks.forget).toHaveBeenCalledWith(deps.prisma, expect.anything());
  });

  it("stops between steps once the API is stopping", async () => {
    const stopping = new AbortController();
    stopping.abort();
    await sweep(["a"]).run(stopping.signal);
    expect(calls).toEqual(["values"]);
    expect(mocks.forget).not.toHaveBeenCalled();
  });

  it("looks at a bounded number of pages per pass", async () => {
    mocks.forget.mockResolvedValue({ looked: 2, last: "z" });
    await sweep([]).run(new AbortController().signal);
    expect(mocks.forget).toHaveBeenCalledTimes(50);
  });
});
