import type * as Logging from "@rakazo/logging";
import type * as GraphileWorker from "graphile-worker";
import type { Runner, RunnerOptions } from "graphile-worker";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ error: vi.fn() }));
const graphile = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("graphile-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof GraphileWorker>()),
  run: graphile.run,
}));
vi.mock("@rakazo/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof Logging>()),
  getLogger: () => logged,
}));

import { DozoJobQueue } from "./dozo-job-queue.js";

afterEach(() => logged.error.mockReset());

function runner(promise: Promise<void> = new Promise(() => undefined)) {
  return { stop: vi.fn(async () => undefined), promise } as unknown as Runner & {
    stop: ReturnType<typeof vi.fn>;
  };
}

describe("DozoJobQueue", () => {
  it("runs only its own tasks, with the payload as queued", async () => {
    const task = vi.fn(async () => undefined);
    const started = runner();
    let options: RunnerOptions | undefined;
    const queue = new DozoJobQueue(
      {} as Pool,
      { "dozo.test": task },
      {
        crontab: "0 * * * * dozo.test",
        start: async (given) => {
          options = given;
          return started;
        },
      },
    );
    await queue.stop();
    expect(Object.keys(options?.taskList ?? {})).toEqual(["dozo.test"]);
    expect(options).toMatchObject({
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 60_000,
      crontab: "0 * * * * dozo.test",
    });
    const run = options?.taskList?.["dozo.test"] as (payload: unknown) => Promise<void>;
    await run({ id: 1 });
    expect(task).toHaveBeenCalledWith({ id: 1 });
    expect(started.stop).toHaveBeenCalledOnce();
  });

  it("reports a runner that did not start, and stops without one", async () => {
    const queue = new DozoJobQueue(
      {} as Pool,
      {},
      {
        start: async () => {
          throw new Error("no database");
        },
      },
    );
    await expect(queue.stop()).resolves.toBeUndefined();
    expect(logged.error).toHaveBeenCalledWith(
      "fork job queue did not start",
      new Error("no database"),
    );
  });

  it("reports a runner that stopped by itself", async () => {
    const queue = new DozoJobQueue(
      {} as Pool,
      {},
      {
        start: async () => runner(Promise.reject(new Error("fatal"))),
      },
    );
    await queue.stop();
    await vi.waitFor(() =>
      expect(logged.error).toHaveBeenCalledWith("fork job queue stopped", new Error("fatal")),
    );
  });

  it("starts Graphile's own runner unless told otherwise", async () => {
    const started = runner();
    graphile.run.mockResolvedValueOnce(started);
    const queue = new DozoJobQueue({} as Pool, {});
    await queue.stop();
    expect(graphile.run).toHaveBeenCalledOnce();
    expect(graphile.run.mock.calls[0]?.[0]).not.toHaveProperty("crontab");
    expect(started.stop).toHaveBeenCalledOnce();
  });
});
