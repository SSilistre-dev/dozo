import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { APIError } from "better-auth/api";

type Sql = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function domainOf(value: string): string | null {
  const labels = value.split(".");
  return value.length <= 253 && labels.length >= 2 && labels.every((label) => LABEL.test(label))
    ? value
    : null;
}

/**
 * What the ban list stores for what an operator typed, or for an account's address: an address in
 * lower case without its `+tag`, or a bare domain (`@example.com` and `*.example.com` name the
 * domain). Null when it is neither.
 */
export function banEntry(input: string): string | null {
  const value = input.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 0) {
    const domain = domainOf(value.replace(/^\*\./, ""));
    return domain && oneDomain(domain);
  }
  const domain = domainOf(value.slice(at + 1));
  if (!domain || at === 0) return domain && oneDomain(domain);
  const local = value.slice(0, at);
  return /[\s@]/.test(local) ? null : mailbox(local, domain);
}

// One mail service answers on two domains and ignores dots in the name before the `@`.
const DOTLESS_DOMAIN = "gmail.com";
const DOTLESS_ALIASES = new Set([DOTLESS_DOMAIN, "googlemail.com"]);

function oneDomain(domain: string): string {
  return DOTLESS_ALIASES.has(domain) ? DOTLESS_DOMAIN : domain;
}

/**
 * The one spelling of a mailbox. A `+tag` goes for every domain, on purpose: most services deliver
 * it to the same person, and where one does not, a ban reaching a second mailbox costs less than a
 * banned person signing up again with a tag. A name that would be empty stays whole.
 */
function mailbox(local: string, domain: string): string {
  const untagged = local.split("+")[0] || local;
  const name = DOTLESS_ALIASES.has(domain) ? untagged.replaceAll(".", "") || untagged : untagged;
  return `${name}@${oneDomain(domain)}`;
}

/**
 * Every entry that refuses this address: the address itself, its domain and each parent domain
 * down to two labels. A banned domain covers its subdomains, since whoever holds a domain makes
 * as many of those as they like; a bare top-level domain is never an entry.
 */
export function banKeys(email: string): string[] {
  // Read more loosely than an operator's entry: whatever sign-up accepted must still find its
  // domain here, or an odd spelling would walk past a banned domain.
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  const domain = oneDomain(value.slice(at + 1).replace(/\.+$/, ""));
  const labels = domain.split(".");
  if (at < 1 || labels.length < 2) return [];
  return [
    mailbox(value.slice(0, at), domain),
    ...labels.slice(0, -1).map((_, index) => labels.slice(index).join(".")),
  ];
}

/** The entries on the list that refuse any of these addresses. */
export async function bannedEntries(prisma: Sql, emails: string[]): Promise<Set<string>> {
  const keys = [...new Set(emails.flatMap(banKeys))];
  if (keys.length === 0) return new Set();
  const rows = await prisma.$queryRaw<{ value: string }[]>`
    SELECT "value" FROM "dozo_bans" WHERE "value" = ANY(${keys}::text[])`;
  return new Set(rows.map((row) => row.value));
}

export async function emailBanned(prisma: Sql, email: string): Promise<boolean> {
  return (await bannedEntries(prisma, [email])).size > 0;
}

/**
 * Refuses a banned address with the answer a deactivated account gets. Whether an account exists
 * does not leak: the answer is the same with and without one. That the address is refused does
 * show, since an ordinary address signs up; the operator accepts that.
 */
export async function refuseBanned(prisma: Sql, email: string): Promise<void> {
  if (await emailBanned(prisma, email))
    throw new APIError("FORBIDDEN", {
      code: "ACCOUNT_DEACTIVATED",
      message: "This account is deactivated",
    });
}

// ponytail: one bounded read, no paging; page it when a deployment's list outgrows this.
const DOZO_BANS_LIMIT = 500;

export function listBans(prisma: Sql): Promise<{ value: string; createdAt: Date }[]> {
  return prisma.$queryRaw`
    SELECT "value", "createdAt" FROM "dozo_bans"
    ORDER BY "createdAt" DESC, "value" ASC LIMIT ${DOZO_BANS_LIMIT}`;
}

/** `value` is a `banEntry`. Adding one that is already listed changes nothing. */
export async function addBan(prisma: Sql, value: string, byUserId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "dozo_bans" ("value", "createdByUserId") VALUES (${value}, ${byUserId})
    ON CONFLICT ("value") DO NOTHING`;
}

export async function removeBan(prisma: Sql, value: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "dozo_bans" WHERE "value" = ${value}`;
}

type AuthUser = { id: string; email: string };

/** The part of the auth instance that the account's own deletion endpoint goes through. */
export interface AccountDeletionAuth {
  $context: Promise<{
    internalAdapter: {
      findUserById(userId: string): Promise<AuthUser | null>;
      deleteUser(userId: string): Promise<unknown>;
      deleteUserSessions(userId: string): Promise<unknown>;
    };
  }>;
  options: {
    user?: {
      deleteUser?: {
        beforeDelete?: (user: never) => Promise<unknown>;
        afterDelete?: (user: never) => Promise<unknown>;
      };
    };
  };
}

/**
 * The steps of the account's own "delete my account", in its order, for an account the operator
 * names. `beforeDelete` is where the server deletes what the account holds (its subscription,
 * Spaces, bots, computers and files); the rows of the account go only once that succeeded.
 * False when there is no such account.
 */
export async function deleteAccountAsOperator(
  auth: AccountDeletionAuth,
  userId: string,
): Promise<boolean> {
  const { internalAdapter } = await auth.$context;
  const user = await internalAdapter.findUserById(userId);
  if (!user) return false;
  const hooks = auth.options.user?.deleteUser;
  try {
    await hooks?.beforeDelete?.(user as never);
  } catch (error) {
    // Another deletion of one of its Spaces is under way; the operator tries again.
    if (error instanceof APIError && error.status === "CONFLICT")
      throw new ClientError("CONFLICT", error.message);
    throw error;
  }
  await internalAdapter.deleteUser(userId);
  await internalAdapter.deleteUserSessions(userId);
  await hooks?.afterDelete?.(user as never);
  return true;
}
