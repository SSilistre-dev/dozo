import { createHash, randomBytes } from "node:crypto";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { takeVerificationMail, VERIFICATION_MAILS_PER_HOUR } from "./dozo-email-link.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("mails per address (PostgreSQL)", () => {
  // An address of its own, so a run leaves the table as it found it.
  const email = `limit-${process.pid}-${randomBytes(3).toString("hex")}@example.test`;
  let db: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    if (!db) return;
    const key = `dozo-verification-mail:${createHash("sha256").update(email).digest("hex")}`;
    await db.prisma.$executeRaw`DELETE FROM "rateLimit" WHERE "key" = ${key}`;
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("counts in one shared row, also when several instances ask at once, and starts over after an hour", async () => {
    const at = Date.now();
    const answers = await Promise.all(
      Array.from({ length: VERIFICATION_MAILS_PER_HOUR + 3 }, () =>
        takeVerificationMail(db.prisma, email, at),
      ),
    );
    expect(answers.filter(Boolean)).toHaveLength(VERIFICATION_MAILS_PER_HOUR);
    expect(await takeVerificationMail(db.prisma, email.toUpperCase(), at + 1000)).toBe(false);
    expect(await takeVerificationMail(db.prisma, email, at + 60 * 60 * 1000 + 1)).toBe(true);
  });
});
