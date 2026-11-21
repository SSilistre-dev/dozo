import type { DozoCommandRuleView } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rules: vi.fn(async (): Promise<DozoCommandRuleView[]> => []) }));
vi.mock("@rakazo/db", () => ({ readDozoCommandRules: db.rules }));

import { dozoWatchCommandRefusal } from "./dozo-watch-command-rules.js";

const block = (words: string[]): DozoCommandRuleView => ({
  words,
  cwd: "",
  effect: "block",
  computer: "user",
});
const routine = { userId: "user-1", botId: "bot-1" };

beforeEach(() => db.rules.mockReset().mockResolvedValue([]));

describe("dozoWatchCommandRefusal", () => {
  it("refuses a running watch once a block rule added later covers its command", async () => {
    expect(
      await dozoWatchCommandRefusal({} as never, routine, "cd app && git push"),
    ).toBeUndefined();
    db.rules.mockResolvedValue([block(["git", "push"])]);
    expect(await dozoWatchCommandRefusal({} as never, routine, "cd app && git push")).toContain(
      "blocked",
    );
    expect(db.rules).toHaveBeenLastCalledWith({}, routine);
  });

  it("leaves a command no block rule covers, and allow rules play no part", async () => {
    db.rules.mockResolvedValue([block(["git", "push"]), { ...block(["ls"]), effect: "allow" }]);
    expect(await dozoWatchCommandRefusal({} as never, routine, "git status")).toBeUndefined();
  });
});
