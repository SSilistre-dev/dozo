import type { PrismaClient } from "./client.js";

/**
 * Who last created or changed each routine (`dozo_routine_writers`, migration
 * `20270123120000_dozo_routine_writers`). The kinds and which of them count as the owner's words
 * are packages/core/src/dozo-lasting-write-approval.ts's (ROUTINE_WRITERS, routineWriterIsOwner).
 */

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/**
 * Records who just wrote a routine of `spaceId`, replacing the last record. A routine elsewhere, or
 * one deleted since, records nothing.
 */
export async function recordRoutineWriter(
  db: Db,
  routine: { routineId: string; spaceId: string },
  writer: string,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "dozo_routine_writers" ("routineId", "spaceId", "writer", "writtenAt")
    SELECT r."id", r."spaceId", ${writer}, CURRENT_TIMESTAMP
    FROM "routines" r WHERE r."id" = ${routine.routineId} AND r."spaceId" = ${routine.spaceId}
    ON CONFLICT ("routineId") DO UPDATE SET
      "writer" = EXCLUDED."writer",
      "writtenAt" = EXCLUDED."writtenAt"`;
}

/** Who last wrote the routine and when, or undefined when nothing was recorded for it. */
export async function readRoutineWriter(
  db: Db,
  routineId: string,
): Promise<{ writer: string; writtenAt: Date } | undefined> {
  const [row] = await db.$queryRaw<Array<{ writer: string; writtenAt: Date }>>`
    SELECT "writer", "writtenAt" AT TIME ZONE 'UTC' AS "writtenAt"
    FROM "dozo_routine_writers" WHERE "routineId" = ${routineId}`;
  return row;
}
