import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { dozoUsageRoutes } from "./dozo-usage.js";
import type { UsageCell } from "./dozo-usage-breakdown.js";
import { groupUsage, readDayCells, usageCsv, usageDayWindow } from "./dozo-usage-breakdown.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

function cell(more: Partial<UsageCell> = {}): UsageCell {
  return {
    provider: "openai",
    model: "small",
    botId: null,
    botName: null,
    deletedBotName: null,
    routineId: null,
    routineName: null,
    routineBotName: null,
    routineUnknown: false,
    calls: 1,
    inputCount: 1,
    inputTokens: 100,
    outputCount: 1,
    outputTokens: 10,
    totalCount: 1,
    totalTokens: 110,
    costCount: 1,
    costUsd: 0.5,
    ...more,
  };
}

const chef = { botId: "bot-chef", botName: "Chef" };
const digest = {
  ...chef,
  routineId: "routine-digest",
  routineName: "Morning digest",
  routineBotName: "Chef",
};

describe("grouping usage", () => {
  const cells = [
    cell({
      ...digest,
      model: "small",
      costUsd: 1,
      calls: 2,
      inputCount: 2,
      outputCount: 2,
      totalCount: 2,
      costCount: 2,
    }),
    cell({ ...digest, model: "large", costUsd: 3 }),
    cell({ ...chef, model: "large", costUsd: 2 }),
    cell({ botId: "bot-gone", deletedBotName: "Old helper", costUsd: 0.25 }),
    cell({ costUsd: 0.125 }),
  ];

  it("sums by model, costliest first, with the provider beside the model", () => {
    expect(
      groupUsage(cells, "model").map((g) => [g.name, g.detail, g.modelCalls, g.costUsd]),
    ).toEqual([
      ["large", "openai", 2, 5],
      ["small", "openai", 4, 1.375],
    ]);
  });

  it("sums by bot and keeps a deleted bot's name", () => {
    expect(groupUsage(cells, "bot").map((g) => [g.name, g.state, g.costUsd])).toEqual([
      ["Chef", "live", 6],
      ["Old helper", "deleted", 0.25],
      [null, "none", 0.125],
    ]);
  });

  it("sums by routine, with the routine's bot, and the rest as no routine", () => {
    expect(groupUsage(cells, "routine").map((g) => [g.name, g.detail, g.state, g.costUsd])).toEqual(
      [
        ["Morning digest", "Chef", "live", 4],
        [null, null, "none", 2.375],
      ],
    );
  });

  it("tells a routine it can no longer name apart from no routine", () => {
    const groups = groupUsage([cell({ routineUnknown: true }), cell()], "routine");
    expect(groups.map((g) => [g.key, g.state])).toEqual([
      ["unknown", "unknown"],
      ["none", "none"],
    ]);
  });

  it("calls a bot unknown when neither it nor its deletion is on record", () => {
    expect(groupUsage([cell({ botId: "bot-lost" })], "bot")[0]).toMatchObject({
      name: null,
      state: "unknown",
    });
  });

  it("breaks ties with named groups first, then by key, whatever order the rows came in", () => {
    const tied = [
      cell({ botId: "lost" }),
      cell(),
      cell({ botId: "b", botName: "Bea" }),
      cell({ botId: "gone", deletedBotName: "Old" }),
      cell({ botId: "a", botName: "Al" }),
    ];
    const order = ["a", "b", "gone", "lost", ""];
    expect(groupUsage(tied, "bot").map((g) => g.key)).toEqual(order);
    expect(groupUsage([...tied].reverse(), "bot").map((g) => g.key)).toEqual(order);
  });

  it("reads a total as unknown when a record in the group lacks the figure", () => {
    const [group] = groupUsage(
      [cell(), cell({ calls: 2, costCount: 1, totalCount: 2, inputCount: 2, outputCount: 0 })],
      "model",
    );
    expect(group).toMatchObject({
      modelCalls: 3,
      costUsd: null,
      totalTokens: 220,
      inputTokens: 200,
      outputTokens: null,
    });
  });
});

describe("grouping usage by day and person", () => {
  it("sums per day, newest first, whatever the cost", () => {
    const groups = groupUsage(
      [
        cell({ day: "2026-11-19", costUsd: 5 }),
        cell({ day: "2026-11-21", costUsd: 1 }),
        cell({ day: "2026-11-20", costUsd: 3 }),
      ],
      "day",
    );
    expect(groups.map((g) => [g.key, g.name, g.state, g.costUsd])).toEqual([
      ["2026-11-21", "2026-11-21", "live", 1],
      ["2026-11-20", "2026-11-20", "live", 3],
      ["2026-11-19", "2026-11-19", "live", 5],
    ]);
  });

  it("sums per person with the email, costliest first, and tells a gone account apart", () => {
    const groups = groupUsage(
      [
        cell({ userId: "ada", userName: "Ada", userEmail: "ada@example.test", costUsd: 1 }),
        cell({ userId: "bob", userName: "Bob", userEmail: "bob@example.test", costUsd: 4 }),
        cell({ userId: "ada", userName: "Ada", userEmail: "ada@example.test", costUsd: 1 }),
        cell({ userId: "gone", userName: null, userEmail: null, costUsd: 0.5 }),
      ],
      "person",
    );
    expect(groups.map((g) => [g.name, g.detail, g.state, g.modelCalls, g.costUsd])).toEqual([
      ["Bob", "bob@example.test", "live", 1, 4],
      ["Ada", "ada@example.test", "live", 2, 2],
      [null, null, "unknown", 1, 0.5],
    ]);
  });

  it("starts the window 30 local days back, and a day turns over at the zone's midnight", () => {
    const at = new Date("2026-11-20T21:30:00Z");
    // Half past midnight in Istanbul is still the 20th in Los Angeles and in UTC.
    expect(usageDayWindow("Europe/Istanbul", at).firstDay).toBe("2026-10-23");
    expect(usageDayWindow("UTC", at).firstDay).toBe("2026-10-22");
    expect(usageDayWindow("America/Los_Angeles", at).firstDay).toBe("2026-10-22");
    expect(usageDayWindow("UTC", new Date("2026-03-01T00:00:00Z")).firstDay).toBe("2026-01-31");
  });
});

describe("reading days", () => {
  const asked = (rows: unknown[][]) => ({
    $queryRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      return rows.shift() ?? (values.length ? [] : []);
    },
  });

  it("reads a name JavaScript refuses as UTC without asking the database about it", async () => {
    const seen: unknown[][] = [];
    const prisma = {
      $queryRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
        seen.push(values);
        return [];
      },
    };
    await readDayCells(prisma, { spaceId: "s", userId: "u" }, "Not/AZone", new Date("2026-11-21Z"));
    // One read, the days themselves, cut in UTC.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("UTC");
  });

  it("keeps a zone both know, and groups cells that lack the optional fields", async () => {
    const prisma = asked([[{ name: "Europe/Istanbul" }], [{ day: "2026-11-21", calls: 1 }]]);
    const cells = await readDayCells(
      prisma,
      { spaceId: "s", userId: "u" },
      "Europe/Istanbul",
      new Date("2026-11-21T12:00:00Z"),
    );
    expect(cells).toMatchObject([{ day: "2026-11-21", calls: 1, provider: "" }]);
    expect(groupUsage([cell(), cell({ userId: "x", userName: "X" })], "person")).toMatchObject([
      { key: "x", name: "X", detail: null },
      { key: "", state: "unknown" },
    ]);
    expect(groupUsage([cell()], "day")).toMatchObject([{ key: "", name: null }]);
  });
});

describe("usage as CSV", () => {
  it("writes the day and person columns, escaping a name that reads as a formula", () => {
    expect(
      usageCsv(groupUsage([cell({ day: "2026-11-21" })], "day"), "day")
        .split("\r\n")
        .slice(0, 2),
    ).toEqual([
      "day,calls,input_tokens,output_tokens,total_tokens,cost_usd",
      "2026-11-21,1,100,10,110,0.5",
    ]);
    const person = usageCsv(
      groupUsage(
        [cell({ userId: "ada", userName: "=cmd|' /C calc'!A0", userEmail: "+ada@example.test" })],
        "person",
      ),
      "person",
    );
    expect(person.split("\r\n").slice(0, 2)).toEqual([
      "person,email,state,calls,input_tokens,output_tokens,total_tokens,cost_usd",
      "'=cmd|' /C calc'!A0,'+ada@example.test,live,1,100,10,110,0.5",
    ]);
  });

  it("writes the grouping's columns and leaves unknown figures empty", () => {
    const csv = usageCsv(
      groupUsage([cell({ ...digest }), cell({ costCount: 0, routineUnknown: true })], "routine"),
      "routine",
    );
    expect(csv).toBe(
      [
        "routine,bot,state,calls,input_tokens,output_tokens,total_tokens,cost_usd",
        "Morning digest,Chef,live,1,100,10,110,0.5",
        ",,unknown,1,100,10,110,",
        "",
      ].join("\r\n"),
    );
  });

  it("quotes separators and keeps a name from reading as a formula", () => {
    const csv = usageCsv(
      groupUsage(
        [
          cell({ botId: "a", botName: '=HYPERLINK("x")', costUsd: 2 }),
          cell({ botId: "b", botName: "Chef, the cook", costUsd: 1 }),
        ],
        "bot",
      ),
      "bot",
    );
    expect(csv.split("\r\n").slice(1, 3)).toEqual([
      `"'=HYPERLINK(""x"")",live,1,100,10,110,2`,
      `"Chef, the cook",live,1,100,10,110,1`,
    ]);
  });

  it("names the model and its provider", () => {
    expect(
      usageCsv(groupUsage([cell()], "model"), "model")
        .split("\r\n")
        .slice(0, 2),
    ).toEqual([
      "model,provider,calls,input_tokens,output_tokens,total_tokens,cost_usd",
      "small,openai,1,100,10,110,0.5",
    ]);
  });
});

describe("who sees the breakdown", () => {
  it("reads only the caller's own records in the current Space, on screen and as CSV", async () => {
    const asked: unknown[][] = [];
    const prisma = {
      $queryRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
        asked.push(values);
        return [cell({ ...chef })];
      },
    };
    const ctx = createRouterContext({
      prisma,
      events: { notify: () => undefined, publishSpaceChange: () => undefined },
      env: {},
    } as unknown as RouterDeps);
    const client = createRouterClient(dozoUsageRoutes(ctx), {
      context: {
        actor: {
          userId: "ada",
          spaceId: "space-ada",
          email: "ada@example.test",
          isDeploymentOwner: false,
        },
      },
    }).dozoUsage;
    expect(await client.breakdown({ by: "bot" })).toMatchObject([{ name: "Chef" }]);
    expect((await client.csv({ by: "bot" })).csv).toContain("Chef,live");
    expect(asked).toEqual([
      ["space-ada", "ada"],
      ["space-ada", "ada"],
    ]);
  });
});

describe("who may group by person", () => {
  type Role = "owner" | "member" | null;
  function clientFor(role: Role, members: number, timezone = "Europe/Istanbul") {
    const asked: string[] = [];
    type Key = { spaceId_userId: { spaceId: string; userId: string } };
    const prisma = {
      spaceMember: {
        // The role belongs to this caller in this Space only: any other key finds nobody.
        findUnique: async ({ where }: { where: Key }) =>
          role &&
          where.spaceId_userId.spaceId === "space-1" &&
          where.spaceId_userId.userId === "ada"
            ? { role }
            : null,
        count: async ({ where }: { where: { spaceId: string } }) =>
          where.spaceId === "space-1" ? members : 0,
      },
      user: { findUnique: async () => ({ timezone }) },
      $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
        // The database knows these zones only.
        if (sql.join("?").includes("pg_timezone_names")) {
          return ["UTC", "Europe/Istanbul"].includes(String(values[0]))
            ? [{ name: values[0] }]
            : [];
        }
        asked.push(values.join("|"));
        return [{ userId: "bob", userName: "Bob", userEmail: "bob@example.test", calls: 1 }];
      },
    };
    const ctx = createRouterContext({
      prisma,
      events: { notify: () => undefined, publishSpaceChange: () => undefined },
      env: {},
    } as unknown as RouterDeps);
    const client = createRouterClient(dozoUsageRoutes(ctx), {
      context: {
        actor: {
          userId: "ada",
          spaceId: "space-1",
          email: "a@example.test",
          isDeploymentOwner: false,
        },
      },
    }).dozoUsage;
    return { client, asked };
  }

  it("shows the owner every member, on screen and as CSV, and offers the option", async () => {
    const { client, asked } = clientFor("owner", 2);
    expect(await client.scope()).toEqual({ person: true });
    expect(await client.breakdown({ by: "person" })).toMatchObject([{ name: "Bob" }]);
    expect((await client.csv({ by: "person" })).csv).toContain("Bob,bob@example.test,live");
    // The whole Space is read, not one user.
    expect(asked).toEqual(["space-1", "space-1"]);
  });

  it("refuses a member on the server, before any record is read, and hides the option", async () => {
    const { client, asked } = clientFor("member", 2);
    expect(await client.scope()).toEqual({ person: false });
    await expect(client.breakdown({ by: "person" })).rejects.toMatchObject({
      name: "SpaceOwnerRequiredError",
    });
    await expect(client.csv({ by: "person" })).rejects.toMatchObject({
      name: "SpaceOwnerRequiredError",
    });
    expect(asked).toEqual([]);
  });

  it("offers nothing to the sole person of a Space, and nothing to a stranger", async () => {
    expect(await clientFor("owner", 1).client.scope()).toEqual({ person: false });
    const stranger = clientFor(null, 2);
    expect(await stranger.client.scope()).toEqual({ person: false });
    await expect(stranger.client.breakdown({ by: "person" })).rejects.toBeDefined();
    expect(stranger.asked).toEqual([]);
  });

  it("falls back to UTC for a zone name the database does not know", async () => {
    // JavaScript accepts this name, so only the database lookup can refuse it.
    const { client, asked } = clientFor("member", 2, "Asia/Kolkata");
    await client.breakdown({ by: "day" });
    expect(asked[0]).toContain("UTC|space-1|ada|");
  });

  it("reads a member's own days in the account's time zone, from their own records", async () => {
    const { client, asked } = clientFor("member", 2);
    await client.breakdown({ by: "day" });
    expect(asked[0]).toContain("Europe/Istanbul|space-1|ada|");
  });
});
