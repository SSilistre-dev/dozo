import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { dozoUsageRoutes } from "./dozo-usage.js";
import type { UsageCell } from "./dozo-usage-breakdown.js";
import { groupUsage, usageCsv } from "./dozo-usage-breakdown.js";
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
    cell({ ...digest, model: "small", costUsd: 1, calls: 2, inputCount: 2, outputCount: 2 }),
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

describe("usage as CSV", () => {
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
