/**
 * The live run's standing trial account, read from a file outside the repository. No imports but
 * Node's, so `canli-account.test.mjs` (`make olc`) checks it offline.
 *
 * The server asks for the mailbox before a password sign-in, and a run cannot read a mailbox on the
 * live site, so the run cannot open an account of its own: its owner opens one trial account once,
 * verifies it, and writes `{"email": "...", "password": "..."}` to the file. canli.sh mounts the
 * file read-only at `CANLI_ACCOUNT_FILE` when it exists and always names its place on the host in
 * `CANLI_ACCOUNT_HOST_PATH`. The content never appears in a message here.
 */
import { readFileSync } from "node:fs";

export type TrialAccount = { email: string; password: string };

export type AccountState =
  | { kind: "none"; hostPath: string }
  | { kind: "ok"; account: TrialAccount };

/** Why the account scenarios are skipped: the file's place and what its owner does about it. */
export function missingReason(hostPath: string): string {
  return `atlandı: deneme hesabı dosyası yok (${hostPath}); sahibi bir kez doğrulanmış bir hesap açıp dosyaya {"email": "...", "password": "..."} yazmalı (izin 0600)`;
}

type Env = Record<string, string | undefined>;

/**
 * No mounted file: the account scenarios skip. A file that is there but unreadable, not JSON, or
 * without a plausible address and a password is an error naming the place, never a skip, so a
 * broken file is not mistaken for an absent one. The parser's own message is left out: it quotes
 * the content.
 */
export function loadAccount(
  env: Env,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): AccountState {
  const hostPath = env.CANLI_ACCOUNT_HOST_PATH ?? "(yol bilinmiyor)";
  const file = env.CANLI_ACCOUNT_FILE;
  if (!file) return { kind: "none", hostPath };
  const broken = (why: string) => new Error(`deneme hesabı dosyası bozuk (${hostPath}): ${why}`);
  let text: string;
  try {
    text = read(file);
  } catch {
    throw broken("okunamadı");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw broken("geçerli JSON değil");
  }
  const { email, password } = (parsed ?? {}) as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email))
    throw broken('"email" geçerli bir adres değil');
  if (typeof password !== "string" || password.length < 8)
    throw broken('"password" yok ya da çok kısa');
  return { kind: "ok", account: { email, password } };
}
