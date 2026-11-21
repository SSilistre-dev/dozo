import { rmSync, writeFileSync } from "node:fs";
import { outDir } from "../scan";
import { loadAccount } from "./account-file";
import { STATE_FILE } from "./live";

/**
 * The live run's finally step (global teardown). The trial account is permanent and is never
 * deleted: the run only forgets its own session file. What it did goes to cleanup.json, the
 * report's "Temizlik" line, with whether an account file was there at all.
 */
export default async function cleanup() {
  rmSync(STATE_FILE(), { force: true });
  let used = false;
  try {
    used = loadAccount(process.env).kind === "ok";
  } catch {
    // A broken file already failed the scenarios that read it; the teardown only reports.
  }
  writeFileSync(
    `${outDir()}/cleanup.json`,
    JSON.stringify({
      accountFile: used,
      account: used
        ? "kalıcı deneme hesabı, silinmedi; oturum dosyası silindi"
        : "deneme hesabı kullanılmadı; oturum dosyası silindi",
    }),
  );
}
