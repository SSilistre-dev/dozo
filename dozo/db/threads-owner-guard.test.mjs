import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  MIGRATIONS,
  main,
  REVIEWED,
  touchesThreadOwners,
  unreviewed,
} from "./threads-owner-guard.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A tree with these migrations and this reviewed list. */
function tree(migrations, reviewed = "") {
  const root = mkdtempSync(join(tmpdir(), "threads-owner-"));
  roots.push(root);
  for (const [name, sql] of Object.entries(migrations)) {
    mkdirSync(join(root, MIGRATIONS, name), { recursive: true });
    writeFileSync(join(root, MIGRATIONS, name, "migration.sql"), sql);
  }
  mkdirSync(join(root, "dozo/db"), { recursive: true });
  writeFileSync(join(root, REVIEWED), reviewed);
  return root;
}

function run(argv) {
  const lines = [];
  const out = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  return { code: main(argv, out), text: lines.join("\n") };
}

describe("touchesThreadOwners", () => {
  it("sees the owner check and every column change on threads", () => {
    for (const sql of [
      'ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";',
      'ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_owner_chk";',
      'ALTER TABLE "threads" ADD COLUMN "projectId" TEXT;',
      'ALTER TABLE ONLY public.threads\n  DROP COLUMN "userId";',
      'ALTER TABLE threads RENAME COLUMN "botId" TO "ownerBotId";',
    ]) {
      assert.equal(touchesThreadOwners(sql), true, sql);
    }
  });

  it("leaves other tables and other changes to threads alone", () => {
    for (const sql of [
      'ALTER TABLE "thread_reads" ADD COLUMN "x" TEXT;',
      'CREATE INDEX "threads_x_idx" ON "threads"("spaceId");',
      'ALTER TABLE "threads" ENABLE ROW LEVEL SECURITY; ALTER TABLE "bots" ADD COLUMN "y" TEXT;',
    ]) {
      assert.equal(touchesThreadOwners(sql), false, sql);
    }
  });
});

describe("the guard", () => {
  const owner = 'ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (true);';

  it("fails (exit 2) on a new upstream migration that touches thread owners, naming it", () => {
    const root = tree({
      "20261301120000_threads_project": 'ALTER TABLE "threads" ADD COLUMN "projectId" TEXT;',
      "20261301130000_owner_again": owner,
      "20261301140000_unrelated": 'ALTER TABLE "bots" ADD COLUMN "y" TEXT;',
    });
    const { code, text } = run(["--root", root]);
    assert.equal(code, 2);
    assert.match(text, /20261301120000_threads_project/);
    assert.match(text, /20261301130000_owner_again/);
    assert.doesNotMatch(text, /unrelated/);
    assert.match(text, /threads-owner-reviewed\.txt/);
  });

  it("passes reviewed upstream migrations and the fork's own", () => {
    const root = tree(
      {
        "20261202120000_background_helper_threads": owner,
        "20270113120000_dozo_bot_chats": owner,
      },
      "# read\n20261202120000_background_helper_threads  # kept\n",
    );
    assert.deepEqual(unreviewed(root), []);
    const { code, text } = run(["--root", root]);
    assert.equal(code, 0);
    assert.match(text, /ok/);
  });

  it("answers 64 to an unknown argument", () => {
    assert.equal(run(["--bogus"]).code, 64);
  });

  it("passes the tree as it is", () => {
    assert.deepEqual(unreviewed(join(import.meta.dirname, "../..")), []);
  });
});
