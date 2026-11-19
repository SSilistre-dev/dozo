import { existsSync, rmSync, writeFileSync } from "node:fs";
import { request } from "@playwright/test";
import { outDir } from "../scan";
import { deleteProbe, readProbe, STATE_FILE, saveProbe } from "./live";

/**
 * The live run's finally step (global teardown): an account the run opened never stays, whatever
 * failed. What it did goes to cleanup.json, the report's "Temizlik" line.
 */
export default async function cleanup() {
  const probe = readProbe();
  const file = `${outDir()}/cleanup.json`;
  if (!probe) return writeFileSync(file, JSON.stringify({ account: "none was created" }));
  if (probe.deleted)
    return writeFileSync(file, JSON.stringify({ account: "deleted by its scenario" }));
  const context = await request.newContext({
    baseURL: process.env.CANLI_URL,
    storageState: existsSync(STATE_FILE()) ? STATE_FILE() : undefined,
  });
  try {
    const seen = await deleteProbe(context, probe);
    saveProbe({ ...probe, deleted: true });
    writeFileSync(file, JSON.stringify({ account: `deleted in the finally step: ${seen}` }));
  } catch (error) {
    writeFileSync(file, JSON.stringify({ account: `NOT deleted: ${String(error)}` }));
    throw error;
  } finally {
    await context.dispose();
    rmSync(STATE_FILE(), { force: true });
  }
}
