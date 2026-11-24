import { ClientError } from "@rakazo/core";
import * as Logging from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import {
  listBotSecrets,
  listVaultItems,
  loadLoginPasswordRedactions,
  relabelVaultItem,
  resolveLoginFill,
  revealBotSecret,
  storeBotSecret,
} from "./bot-secrets.js";
import { accountVault, fakeDatabase } from "./bot-secrets.test-support.js";
import {
  DEVICE_LOGIN_ONLY,
  deviceLoginOf,
  encodeDeviceLogin,
  rejectDeviceLoginReveal,
  unlinkDeviceLogin,
} from "./dozo-device-login.js";
import { EncryptedSecretStore } from "./secrets.js";
import { LOGIN_CODE_FIELD } from "./vault-card-use.js";

const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const scope = { userId: "user-1", spaceId: "space-1" };
const HANDLE = "AbCdEfGhIjKlMnOpQrStUv";
const SITE = "https://login.example.test";
const context = { operationId: "t", traceId: "t", signal: new AbortController().signal };

/** A login the way the computer's route saves it: only the device and the handle are stored. */
async function linked(
  db: ReturnType<typeof fakeDatabase>,
  options: { deviceId?: string; name?: string; policy?: string; alsoOn?: string[] } = {},
) {
  const name = options.name ?? "work";
  const id = `login-${name}`;
  const { ciphertext } = await secretStore.put(
    encodeDeviceLogin({ deviceId: options.deviceId ?? "device-1", handle: HANDLE }),
    { ...scope, ...context },
    { recordId: id },
  );
  await db.prisma.vaultCredential.create({
    data: {
      id,
      ...accountVault,
      name,
      origin: SITE,
      auth: { type: "login" },
      ciphertext,
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.alsoOn ? { alsoOn: options.alsoOn } : {}),
    } as never,
  });
  return id;
}

const fill = (
  db: ReturnType<typeof fakeDatabase>,
  more: Partial<Parameters<typeof resolveLoginFill>[0]> = {},
) =>
  resolveLoginFill({
    prisma: db.prisma,
    secretStore,
    scope,
    runId: "run-1",
    name: "work",
    field: "Password",
    ...more,
  });

describe("what is stored for a login linked to a computer", () => {
  it("is the device and the handle and nothing else", () => {
    const stored = encodeDeviceLogin({ deviceId: "device-1", handle: HANDLE });
    expect(JSON.parse(stored)).toEqual({ deviceLogin: { deviceId: "device-1", handle: HANDLE } });
    expect(deviceLoginOf(stored)).toEqual({ deviceId: "device-1", handle: HANDLE });
  });

  it("is recognised by its exact shape only", () => {
    const login = { fields: [{ label: "Password", value: "x", hidden: true }] };
    for (const other of [
      JSON.stringify(login),
      JSON.stringify({ username: "a", password: "b" }),
      JSON.stringify({ deviceLogin: { deviceId: "d", handle: "short" } }),
      JSON.stringify({ deviceLogin: { deviceId: "", handle: HANDLE } }),
      JSON.stringify({ deviceLogin: { deviceId: "d", handle: HANDLE, value: "x" } }),
      JSON.stringify({ deviceLogin: { deviceId: "d", handle: HANDLE }, fields: login.fields }),
      JSON.stringify([{ deviceLogin: { deviceId: "d", handle: HANDLE } }]),
      "not json",
      "",
    ])
      expect(deviceLoginOf(other)).toBeUndefined();
    expect(() => encodeDeviceLogin({ deviceId: "d", handle: "short" })).toThrow();
  });
});

describe("filling a login linked to a computer", () => {
  it("gives the handle and the field, never a value, only to that computer", async () => {
    const db = fakeDatabase();
    await linked(db);
    const own = { deviceId: "device-1" };
    expect(await fill(db, own)).toEqual({
      text: "",
      hidden: true,
      origin: SITE,
      sites: [SITE],
      redactions: [],
      used: expect.objectContaining({ name: "work", kind: "login" }),
      deviceLogin: { handle: HANDLE, field: "password" },
    });
    expect(await fill(db, { ...own, field: " username " })).toMatchObject({
      hidden: false,
      deviceLogin: { handle: HANDLE, field: "username" },
    });
    expect(await fill(db, { ...own, field: LOGIN_CODE_FIELD, code: true })).toMatchObject({
      deviceLogin: { handle: HANDLE, field: "code" },
      used: expect.objectContaining({ name: "work" }),
    });
    expect(await fill(db, { ...own, field: "Pin" })).toEqual({
      error: 'This login has no field named "Pin". Its fields: Username, Password.',
    });
  });

  it("is refused anywhere else with one sentence: the hosted computer and another computer", async () => {
    const db = fakeDatabase();
    await linked(db);
    for (const more of [{}, { deviceId: "device-2" }, { code: true as const }])
      expect(await fill(db, more)).toEqual({ error: DEVICE_LOGIN_ONLY });
    expect(DEVICE_LOGIN_ONLY).toBe("This login can only be filled in your own computer's browser.");
  });

  it("is the only thing the user's browser fills: other logins stay refused there", async () => {
    const db = fakeDatabase();
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: { name: "plain", origin: SITE, auth: { type: "login" } },
      plaintext: JSON.stringify({
        fields: [{ label: "Password", value: "fake-password-1", hidden: true }],
      }),
    });
    const device = { deviceId: "device-1", name: "plain" };
    expect(await fill(db, device)).toEqual({ error: "Saved logins are unavailable here." });
    expect(await fill(db, { ...device, code: true })).toEqual({
      error: "Codes are unavailable here.",
    });
    // Still filled on the bot's own computer, as before.
    expect(await fill(db, { name: "plain" })).toMatchObject({ text: "fake-password-1" });
  });

  it("asks first when its policy says so, and fills on the site the user approved", async () => {
    const db = fakeDatabase();
    await linked(db, { policy: "ask", alsoOn: ["https://www.login.example.test"] });
    const own = { deviceId: "device-1" };
    expect(await fill(db, own)).toEqual({
      error: "The user has not approved signing in with this login here.",
    });
    const savedAt = db.rows()[0]!.updatedAt!.toISOString();
    const approval = {
      kind: "login" as const,
      login: "work",
      site: "https://www.login.example.test",
      title: "",
      fields: ["Password"],
      savedAt,
    };
    expect(await fill(db, { ...own, approval })).toMatchObject({
      origin: "https://www.login.example.test",
      deviceLogin: { handle: HANDLE, field: "password" },
    });
    await relabelVaultItem(db.prisma, scope, "work", { title: "Work" });
    expect(await fill(db, { ...own, approval })).toEqual({
      error: expect.stringContaining("changed after the user approved it"),
    });
  });

  it("fills on the page's own site when it is one of the login's", async () => {
    const db = fakeDatabase();
    await linked(db, { alsoOn: ["https://www.login.example.test"] });
    expect(
      await fill(db, { deviceId: "device-1", pageUrl: "https://www.login.example.test/in" }),
    ).toMatchObject({
      origin: "https://www.login.example.test",
      sites: [SITE, "https://www.login.example.test"],
    });
  });

  it("is not a login this run typed itself", async () => {
    const db = fakeDatabase();
    await linked(db);
    // A run's own login was never saved: it is the person's answer, not a link.
    const { ciphertext } = await secretStore.put(
      JSON.stringify({
        origin: SITE,
        login: JSON.stringify({ fields: [{ label: "Password", value: "typed-1", hidden: true }] }),
      }),
      { ...scope, ...context },
      { recordId: "run-login" },
    );
    Object.assign(db.prisma.secret, {
      findFirst: async () => ({ id: "run-login", ciphertext }),
    });
    expect(await fill(db, { deviceId: "device-1" })).toEqual({
      error: "Saved logins are unavailable here.",
    });
    expect(await fill(db, { deviceId: "device-1", code: true })).toEqual({
      error: "Codes are unavailable here.",
    });
  });
});

describe("a linked login elsewhere in the vault", () => {
  it("is listed to the bot and the owner with no username and no warning", async () => {
    const db = fakeDatabase();
    await linked(db);
    const warn = vi.fn();
    const logger = vi.spyOn(Logging, "getLogger").mockReturnValue({ warn } as never);
    try {
      expect(await listBotSecrets(db.prisma, secretStore, scope)).toEqual([
        expect.objectContaining({ name: "work", origin: SITE }),
      ]);
      const [item] = await listVaultItems(db.prisma, secretStore, scope);
      expect(item).toMatchObject({ name: "work", title: "login.example.test" });
      expect(item!.preview).toBeUndefined();
      expect(JSON.stringify(await listBotSecrets(db.prisma, secretStore, scope))).not.toContain(
        "username",
      );
      expect(await loadLoginPasswordRedactions(db.prisma, secretStore, scope)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      logger.mockRestore();
    }
  });

  it("has no value for the owner to reveal", async () => {
    const db = fakeDatabase();
    await linked(db);
    await expect(
      revealBotSecret({ prisma: db.prisma, secretStore, scope, name: "work" }),
    ).rejects.toThrow(ClientError);
    await expect(
      revealBotSecret({ prisma: db.prisma, secretStore, scope, name: "work" }),
    ).rejects.toThrow("This login has no stored value.");
  });

  it("holds nothing a person typed: its stored text is the handle and the device", async () => {
    const db = fakeDatabase();
    await linked(db);
    const [row] = db.rows();
    expect(JSON.parse(await secretStore.load(row!.ciphertext, row!.id))).toEqual({
      deviceLogin: { deviceId: "device-1", handle: HANDLE },
    });
  });
});

describe("a linked login the owner saves a real value over", () => {
  /** The link rows of the fake database: the write must delete the row of the item it overwrites. */
  function withLinks(db: ReturnType<typeof fakeDatabase>, ids: string[]) {
    const deleted: unknown[] = [];
    Object.assign(db.prisma, {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!strings.join("?").includes("DELETE FROM dozo_device_logins"))
          throw new Error("unexpected");
        deleted.push(values[0]);
        return ids.includes(values[0] as string) ? 1 : 0;
      },
    });
    return deleted;
  }
  const save = (db: ReturnType<typeof fakeDatabase>, name: string) =>
    storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: { name, origin: SITE, auth: { type: "login" } },
      plaintext: JSON.stringify({
        fields: [{ label: "Password", value: "typed-by-owner-1", hidden: true }],
      }),
    });

  it("stops being a linked login in the same write", async () => {
    const db = fakeDatabase();
    const id = await linked(db);
    const deleted = withLinks(db, [id]);
    await save(db, "work");
    expect(deleted).toEqual([id]);
    expect(await fill(db, { deviceId: "device-1" })).toEqual({
      error: "Saved logins are unavailable here.",
    });
  });

  it("leaves an ordinary login's overwrite and a new login alone", async () => {
    const db = fakeDatabase();
    const deleted = withLinks(db, []);
    await save(db, "plain");
    await save(db, "plain");
    expect(deleted).toEqual([]);
  });
});

describe("the helpers a linked login's reveal and overwrite go through", () => {
  const linked = encodeDeviceLogin({ deviceId: "device-1", handle: HANDLE });

  it("refuses to reveal a linked login, which has no stored value, and lets any other through", () => {
    expect(() => rejectDeviceLoginReveal(linked)).toThrow(ClientError);
    expect(() => rejectDeviceLoginReveal('{"fields":[]}')).not.toThrow();
  });

  it("unlinks only an item whose old value was a link, and never one it cannot read", async () => {
    const sql: string[] = [];
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray) => {
        sql.push(strings.join("?"));
        return 1;
      },
    };
    await unlinkDeviceLogin(tx, "item-1", async () => linked);
    await unlinkDeviceLogin(tx, "item-2", async () => '{"fields":[]}');
    await unlinkDeviceLogin(tx, "item-3", async () => {
      throw new Error("unreadable");
    });
    expect(sql).toEqual(['DELETE FROM dozo_device_logins WHERE "credentialId" = ?']);
  });
});
