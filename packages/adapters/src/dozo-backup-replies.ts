import type { PrismaClient } from "@rakazo/db";
import { recordBackupReply } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

/**
 * Which runs a backup model answered (packages/db/src/dozo-backup-replies.ts), so a reply can say
 * which model wrote it when it was not the one chosen. Recording never fails a run.
 */

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;
type Model = { provider?: string | null; id?: string | null };

const same = (left: Model, right: Model) =>
  left.provider === right.provider && left.id === right.id;

/**
 * At a run's start: whether it starts on its chosen model or on a backup (the chosen one could
 * not start or rests). A run with no chosen model has no backup to tell apart.
 */
export function runStartedOn(
  prisma: Db,
  run: { id: string },
  selected: Model,
  running: { provider: string; id: string },
) {
  if (!selected.provider || !selected.id) return Promise.resolve(undefined);
  if (same(selected, running)) {
    // An earlier attempt of the run may have run on a backup: its mark goes, without holding up
    // the start (most runs start on their model and have none).
    void bestEffort("backup reply record", recordBackupReply(prisma, run, null));
    return Promise.resolve(undefined);
  }
  return bestEffort(
    "backup reply record",
    recordBackupReply(prisma, run, { provider: running.provider, modelId: running.id }),
  );
}

/** A switch to a backup during the run: the run is answered by that backup from then on. */
export function runSwitchedTo(
  prisma: Db,
  run: { id: string },
  started: Model,
  next: { provider: string; id: string },
) {
  if (same(started, next)) return Promise.resolve(undefined);
  return bestEffort(
    "backup reply record",
    recordBackupReply(prisma, run, { provider: next.provider, modelId: next.id }),
  );
}
