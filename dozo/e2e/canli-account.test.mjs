// Offline test of canli/account-file.ts (`make olc`): the live run's standing trial account file.
// No file means the account scenarios skip; a file that is there but broken is an error, never a
// skip; and no message quotes the file's content.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadAccount, missingReason } from "./canli/account-file.ts";

const HOST = "/home/owner/.config/dozo/canli-hesap.json";
const env = (extra = {}) => ({ CANLI_ACCOUNT_HOST_PATH: HOST, ...extra });
const reading = (text) => () => text;

test("no mounted file: none, with the file's place for the skip reason", () => {
  assert.deepEqual(loadAccount(env()), { kind: "none", hostPath: HOST });
  const reason = missingReason(HOST);
  assert.match(reason, /^atlandı: deneme hesabı dosyası yok/);
  assert.ok(reason.includes(HOST), "the reason names the file");
  assert.match(reason, /"email".*"password"/, "and says what the owner writes into it");
});

test("a good file gives the account", () => {
  const text = JSON.stringify({
    email: "owner+trial@example.test",
    password: "a long enough pass",
  });
  assert.deepEqual(loadAccount(env({ CANLI_ACCOUNT_FILE: "/run/f" }), reading(text)), {
    kind: "ok",
    account: { email: "owner+trial@example.test", password: "a long enough pass" },
  });
});

test("a file that is there but broken is an error naming the place, never none", () => {
  const secret = "s3cret-value-1234";
  const cases = {
    "not JSON": `{"email": "a@b.test", "password": "${secret}"`,
    "not an object": "null",
    "no email": JSON.stringify({ password: secret }),
    "bad email": JSON.stringify({ email: "no-at-sign", password: secret }),
    "no password": JSON.stringify({ email: "a@b.test" }),
    "short password": JSON.stringify({ email: "a@b.test", password: "short" }),
    "password not text": JSON.stringify({ email: "a@b.test", password: 12345678 }),
    empty: "",
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.throws(
      () => loadAccount(env({ CANLI_ACCOUNT_FILE: "/run/f" }), reading(text)),
      (error) => {
        assert.ok(error.message.startsWith(`deneme hesabı dosyası bozuk (${HOST})`), name);
        assert.ok(!error.message.includes(secret), `${name}: the message quotes the file`);
        assert.ok(!error.message.includes("a@b.test"), `${name}: the message quotes the address`);
        return true;
      },
      name,
    );
  }
});

test("a mounted file that cannot be read is an error too", () => {
  assert.throws(
    () =>
      loadAccount(env({ CANLI_ACCOUNT_FILE: "/run/f" }), () => {
        throw new Error("EACCES: permission denied, open '/run/f'");
      }),
    /deneme hesabı dosyası bozuk \(.*\): okunamadı/,
  );
});

test("the default reader reads a real file", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/canli-account-`);
  try {
    const file = `${dir}/hesap.json`;
    writeFileSync(file, JSON.stringify({ email: "a@b.test", password: "long enough pass" }));
    assert.equal(loadAccount(env({ CANLI_ACCOUNT_FILE: file })).kind, "ok");
    assert.throws(() => loadAccount(env({ CANLI_ACCOUNT_FILE: `${dir}/yok.json` })), /okunamadı/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
