import { createDb } from "@rakazo/db";

/**
 * Marks a screenshot fixture's address as proven. A server with mail (the catalog's runs an email
 * emulator) gives a password sign-up no session until the address is verified, and refuses an
 * unverified password sign-in (`packages/auth/src/dozo-verify-email.ts`); the fixture accounts have
 * no mailbox to verify with. Test tooling only: the product's verification is unchanged.
 */
export async function dozoVerifyFixtureEmail(databaseUrl: string, email: string): Promise<void> {
  const db = createDb(databaseUrl, { applicationName: "ios-screenshots" });
  try {
    await db.prisma.user.updateMany({
      where: { email: email.toLowerCase() },
      data: { emailVerified: true },
    });
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}
