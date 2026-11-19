import { databaseOutage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Runner, RunnerOptions } from "graphile-worker";
import { run } from "graphile-worker";
import type { Pool } from "pg";
import { jobQueueLogger } from "./wakeup.js";

/** The fork's jobs wait for a date, so checking once a minute for a due one is on time. */
const DUE_CHECK_MS = 60_000;
/** Graphile's backoff grows with each try; ten spread a failing send over a few hours. */
const MAX_ATTEMPTS = 10;

export type DozoTask = (payload: unknown) => Promise<void>;

/**
 * Timed work of the fork's own, on upstream's Graphile queue but run by the process that holds what
 * the tasks need (the API, which has the account email). A Graphile runner claims only the tasks it
 * lists, so upstream's worker never takes these and this runner never takes upstream's. One job
 * per key: queueing again under a key replaces the job, and a job that fails is retried with
 * Graphile's backoff.
 */
export class DozoJobQueue {
  private readonly runner: Promise<Runner | undefined>;

  constructor(
    private readonly pool: Pool,
    tasks: Readonly<Record<string, DozoTask>>,
    start: (options: RunnerOptions) => Promise<Runner> = run,
  ) {
    this.runner = start({
      pgPool: pool,
      concurrency: 1,
      pollInterval: DUE_CHECK_MS,
      // The API's own shutdown stops this runner; Graphile must not handle the signal itself.
      noHandleSignals: true,
      logger: jobQueueLogger(databaseOutage),
      taskList: Object.fromEntries(
        Object.entries(tasks).map(([name, task]) => [name, (payload: unknown) => task(payload)]),
      ),
    }).then(
      (runner) => {
        runner.promise.catch((error: unknown) =>
          getLogger().error("fork job queue stopped", error),
        );
        return runner;
      },
      (error: unknown) => {
        getLogger().error("fork job queue did not start", error);
        return undefined;
      },
    );
  }

  /** Queues `task` to run at `runAt` with `payload`, replacing any job queued under `key`. */
  async add(task: string, key: string, runAt: Date, payload: object): Promise<void> {
    await this.pool.query(
      `select graphile_worker.add_job($1::text, $2::json, run_at => $3::timestamptz,
         max_attempts => $4::int, job_key => $5::text)`,
      // The date as text with its zone, as upstream's publisher sends it.
      [task, JSON.stringify(payload), runAt.toISOString(), MAX_ATTEMPTS, key],
    );
  }

  /** Stops taking jobs and waits for the running one. */
  async stop(): Promise<void> {
    await (await this.runner)?.stop();
  }
}
