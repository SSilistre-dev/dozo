import { expect, it, vi } from "vitest";

// Runs on the branded tree only: the lifecycle reaches the announcement through an anchored rule.

const announce = vi.hoisted(() => ({
  calls: [] as Array<{ computerId: string }>,
}));
vi.mock("./dozo-computer-announce.js", () => ({
  announceWhenStarted: async (
    _deps: unknown,
    computerId: string,
    start: () => Promise<unknown>,
  ) => {
    announce.calls.push({ computerId });
    return start();
  },
}));

import { provisionComputer } from "./computer-lifecycle.js";

it("starts every computer through the running announcement", async () => {
  const missing = new Error("no such computer");
  const deps = {
    prisma: {
      computer: {
        findUniqueOrThrow: vi.fn(async () => {
          throw missing;
        }),
      },
    },
  } as never;
  await expect(provisionComputer(deps, "computer-1", {} as never)).rejects.toBe(missing);
  expect(announce.calls).toEqual([{ computerId: "computer-1" }]);
});
