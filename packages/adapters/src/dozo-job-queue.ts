import { databaseOutage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Runner, RunnerOptions } from "graphile-worker";
import { run } from "graphile-worker";
import type { Pool } from "pg";
import { jobQueueLogger } from "./wakeup.js";

/**
 * Graphile's own check for jobs that have come due. New jobs arrive by notification at once; this
 * only finds a job whose time has come (a reminder days ahead, a backup that fires after its
 * attempt's timeout), where a minute late is on time.
 */
const DUE_CHECK_MS = 60_000;

type DozoTask = (payload: unknown) => Promise<void>;

/**
 * Runs the fork's own jobs, on upstream's Graphile queue but in the process that holds what the
 * tasks need (the API, which has the account email). A Graphile runner claims only the tasks it
 * lists, so upstream's worker never takes these and this runner never takes upstream's. Jobs are
 * added with SQL in the transaction that records their work; a job that fails is retried with
 * Graphile's backoff. Give it a pool of its own: the runner keeps one connection listening and
 * runs one job at a time, so two connections are all it uses.
 */
export class DozoJobQueue {
  private readonly runner: Promise<Runner | undefined>;

  constructor(
    pool: Pool,
    tasks: Readonly<Record<string, DozoTask>>,
    options: {
      /**
       * Graphile's crontab lines for tasks that run on a schedule (a slow safety net); Graphile
       * runs each scheduled time once across every process that lists it.
       */
      crontab?: string;
      start?: (options: RunnerOptions) => Promise<Runner>;
    } = {},
  ) {
    const start = options.start ?? run;
    this.runner = start({
      pgPool: pool,
      ...(options.crontab ? { crontab: options.crontab } : {}),
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

  /** Stops taking jobs and waits for the running one. */
  async stop(): Promise<void> {
    await (await this.runner)?.stop();
  }
}
