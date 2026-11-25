import { ClientError } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { fakeDatabase } from "./secrets/bot-secrets.test-support.js";
import { deviceLoginOf } from "./dozo-device-login.js";
import { createDeviceLogin, deleteDeviceLogin, deviceCanLink } from "./dozo-device-login-store.js";
import { EncryptedSecretStore } from "./secrets/secrets.js";

const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const device = { id: "device-1", userId: "user-1" };
const HANDLE = "AbCdEfGhIjKlMnOpQrStUv";
const OTHER_HANDLE = "ZyXwVuTsRqPoNmLkJiHgFe";
const SITE = "https://bank.example.test";

/** The vault in memory, with the link table and the device's row the SQL reads and writes. */
function setup(options: { revoked?: boolean } = {}) {
  const db = fakeDatabase();
  const links: { deviceId: string; handle: string; credentialId: string }[] = [];
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const { vaultCredential } = db.prisma as unknown as {
    vaultCredential: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
  };
  const create = vaultCredential.create.bind(vaultCredential);
  const state = { staleNames: 0, creates: 0, declared: undefined as string[] | undefined };
  vaultCredential.create = async (args) => {
    state.creates += 1;
    // A concurrent save took the name: the unique index refuses this one.
    const rows = db.rows();
    if (rows.some((row) => row.name === args.data.name && row.spaceId === args.data.spaceId))
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    return create(args);
  };
  const names = (
    db.prisma as unknown as { vaultCredential: { findMany: (args: unknown) => Promise<unknown> } }
  ).vaultCredential;
  const findMany = names.findMany.bind(names);
  // A concurrent save is not seen yet: the free name it picks is already taken.
  names.findMany = async (args) => (state.staleNames-- > 0 ? [] : findMany(args));
  const client = db.prisma as unknown as Record<string, unknown>;
  client.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = sql(strings);
    if (text.includes("FROM dozo_device_logins l JOIN")) {
      const link = links.find(
        (entry) => entry.deviceId === values[0] && entry.handle === values[1],
      );
      const row = db.rows().find((entry) => entry.id === link?.credentialId);
      return row ? [{ name: row.name }] : [];
    }
    if (text.includes('SELECT "credentialId"'))
      return links
        .filter(
          (entry) =>
            entry.deviceId === values[0] && (values[1] === null || entry.handle === values[1]),
        )
        .map((entry) => ({ id: entry.credentialId }));
    if (text.includes("FROM dozo_device_capabilities"))
      return state.declared ? [{ capabilities: state.declared }] : [];
    if (text.includes("FROM user_devices")) return options.revoked ? [] : [{ id: values[0] }];
    if (text.includes('FROM "user"')) return [{ id: values[0] }];
    throw new Error(`unexpected SQL ${text}`);
  };
  client.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!sql(strings).includes("INSERT INTO dozo_device_logins")) throw new Error("unexpected SQL");
    if (links.some((entry) => entry.deviceId === values[0] && entry.handle === values[1]))
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    links.push({
      deviceId: values[0] as string,
      handle: values[1] as string,
      credentialId: values[2] as string,
    });
    return 1;
  };
  return { db, links, state, deps: { prisma: db.prisma, secretStore } };
}

describe("linking a login that stays in a password manager", () => {
  it("saves an account vault login that holds only the device and the handle", async () => {
    const { db, links, deps } = setup();
    expect(
      await createDeviceLogin(deps, device, { title: "My Bank", origin: SITE, handle: HANDLE }),
    ).toEqual({ name: "my-bank", created: true });
    const [row] = db.rows();
    expect(row).toMatchObject({
      userId: "user-1",
      spaceId: null,
      name: "my-bank",
      title: "My Bank",
      origin: SITE,
      auth: { type: "login" },
      policy: "allow",
    });
    expect(deviceLoginOf(await secretStore.load(row!.ciphertext, row!.id))).toEqual({
      deviceId: "device-1",
      handle: HANDLE,
    });
    expect(links).toEqual([{ deviceId: "device-1", handle: HANDLE, credentialId: row!.id }]);
  });

  it("names each new login from its title, one free name per title", async () => {
    const { db, deps } = setup();
    const names = [];
    for (const [title, handle] of [
      ["Bank", HANDLE],
      ["Bank", OTHER_HANDLE],
      ["日本", "AAAAAAAAAAAAAAAAAAAAAA"],
    ] as const)
      names.push((await createDeviceLogin(deps, device, { title, origin: SITE, handle })).name);
    expect(names).toEqual(["bank", "bank-2", "login"]);
    expect(db.rows()).toHaveLength(3);
  });

  it("answers a handle it already holds with its name and saves nothing again", async () => {
    const { db, deps } = setup();
    await createDeviceLogin(deps, device, { title: "Bank", origin: SITE, handle: HANDLE });
    expect(
      await createDeviceLogin(deps, device, { title: "Other", origin: SITE, handle: HANDLE }),
    ).toEqual({ name: "bank", created: false });
    expect(db.rows()).toHaveLength(1);
  });

  it("tries again when a concurrent save took the name", async () => {
    const { db, state, deps } = setup();
    await createDeviceLogin(deps, device, { title: "Bank", origin: SITE, handle: HANDLE });
    state.staleNames = 1;
    expect(
      await createDeviceLogin(deps, device, { title: "Bank", origin: SITE, handle: OTHER_HANDLE }),
    ).toEqual({ name: "bank-2", created: true });
    expect(db.rows().map((row) => row.name)).toEqual(["bank", "bank-2"]);
  });

  it("gives up when the name stays taken", async () => {
    const { state, deps } = setup();
    await createDeviceLogin(deps, device, { title: "Bank", origin: SITE, handle: HANDLE });
    state.staleNames = 99;
    await expect(
      createDeviceLogin(deps, device, { title: "Bank", origin: SITE, handle: OTHER_HANDLE }),
    ).rejects.toThrow("Unique constraint failed");
  });

  it("refuses at the vault's limit, and for a computer that was disconnected meanwhile", async () => {
    const full = setup();
    for (let index = 0; index < 100; index += 1)
      await full.db.prisma.vaultCredential.create({
        data: {
          id: `item-${index}`,
          userId: "user-1",
          spaceId: null,
          name: `item-${index}`,
          origin: SITE,
          auth: { type: "login" },
          ciphertext: "x",
        } as never,
      });
    const refused = createDeviceLogin(full.deps, device, {
      title: "Bank",
      origin: SITE,
      handle: HANDLE,
    });
    await expect(refused).rejects.toBeInstanceOf(ClientError);
    await expect(refused).rejects.toMatchObject({ kind: "CONFLICT" });
    expect(full.links).toEqual([]);

    const revoked = setup({ revoked: true });
    const gone = createDeviceLogin(revoked.deps, device, {
      title: "Bank",
      origin: SITE,
      handle: HANDLE,
    });
    await expect(gone).rejects.toMatchObject({ kind: "UNAUTHORIZED" });
    expect(revoked.db.rows()).toEqual([]);
  });
});

describe("which computers may link", () => {
  it("is a computer that declared passwords, never a phone, never one that declared nothing", async () => {
    const { state, deps } = setup();
    const mac = { id: "device-1", platform: "darwin" };
    expect(await deviceCanLink(deps.prisma, mac)).toBe(false);
    state.declared = ["shell", "browser"];
    expect(await deviceCanLink(deps.prisma, mac)).toBe(false);
    state.declared = ["shell", "passwords"];
    expect(await deviceCanLink(deps.prisma, mac)).toBe(true);
    expect(await deviceCanLink(deps.prisma, { id: "phone-1", platform: "ios" })).toBe(false);
  });
});

describe("unlinking", () => {
  async function two() {
    const run = setup();
    await createDeviceLogin(run.deps, device, { title: "Bank", origin: SITE, handle: HANDLE });
    await createDeviceLogin(run.deps, device, {
      title: "Mail",
      origin: SITE,
      handle: OTHER_HANDLE,
    });
    await createDeviceLogin(
      run.deps,
      { id: "device-2", userId: "user-1" },
      { title: "Chat", origin: SITE, handle: "AAAAAAAAAAAAAAAAAAAAAA" },
    );
    return run;
  }

  it("removes one login of a computer by its handle and no other", async () => {
    const { db, deps } = await two();
    expect(await deleteDeviceLogin(deps.prisma, "device-1", HANDLE)).toBe(true);
    expect(db.rows().map((row) => row.name)).toEqual(["mail", "chat"]);
    expect(await deleteDeviceLogin(deps.prisma, "device-1", HANDLE)).toBe(false);
  });

  it("never removes another computer's login, whichever handle it names", async () => {
    const { db, deps } = await two();
    expect(await deleteDeviceLogin(deps.prisma, "device-1", "AAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(await deleteDeviceLogin(deps.prisma, "device-9", HANDLE)).toBe(false);
    expect(db.rows()).toHaveLength(3);
  });

  it("asks nothing of the vault when there is none to remove", async () => {
    const { db, deps } = setup();
    expect(await deleteDeviceLogin(deps.prisma, "device-9", HANDLE)).toBe(false);
    expect(
      (db.prisma as unknown as { vaultCredential: { deleteMany: { mock: { calls: unknown[] } } } })
        .vaultCredential.deleteMany.mock.calls,
    ).toEqual([]);
  });
});
