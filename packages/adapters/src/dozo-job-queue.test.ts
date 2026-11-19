import type * as Logging from "@rakazo/logging";
import type { Runner, RunnerOptions } from "graphile-worker";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ error: vi.fn() }));
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
    const queue = new DozoJobQueue({} as Pool, { "dozo.test": task }, async (given) => {
      options = given;
      return started;
    });
    await queue.stop();
    expect(Object.keys(options?.taskList ?? {})).toEqual(["dozo.test"]);
    expect(options).toMatchObject({ concurrency: 1, noHandleSignals: true, pollInterval: 60_000 });
    const run = options?.taskList?.["dozo.test"] as (payload: unknown) => Promise<void>;
    await run({ id: 1 });
    expect(task).toHaveBeenCalledWith({ id: 1 });
    expect(started.stop).toHaveBeenCalledOnce();
  });

  it("queues a job under its key, for its time, with a bounded number of tries", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const queue = new DozoJobQueue({ query } as unknown as Pool, {}, async () => runner());
    await queue.add("dozo.test", "dozo.test:org", new Date("2026-11-22T12:00:00.000Z"), {
      organizationId: "org",
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("graphile_worker.add_job"), [
      "dozo.test",
      '{"organizationId":"org"}',
      "2026-11-22T12:00:00.000Z",
      10,
      "dozo.test:org",
    ]);
  });

  it("reports a runner that did not start, and stops without one", async () => {
    const queue = new DozoJobQueue({} as Pool, {}, async () => {
      throw new Error("no database");
    });
    await expect(queue.stop()).resolves.toBeUndefined();
    expect(logged.error).toHaveBeenCalledWith(
      "fork job queue did not start",
      new Error("no database"),
    );
  });

  it("reports a runner that stopped by itself", async () => {
    const queue = new DozoJobQueue({} as Pool, {}, async () =>
      runner(Promise.reject(new Error("fatal"))),
    );
    await queue.stop();
    await vi.waitFor(() =>
      expect(logged.error).toHaveBeenCalledWith("fork job queue stopped", new Error("fatal")),
    );
  });
});
