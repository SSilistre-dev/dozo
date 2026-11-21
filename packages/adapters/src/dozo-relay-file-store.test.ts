import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RelayHostChannel } from "@rakazo/core";
import { encodeRelayBytes, webRelayCrypto } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileRelayStore, replaceFile } from "./dozo-relay-file-store.js";

const crypto = webRelayCrypto();
let dir: string;

beforeEach(async () => {
  dir = path.join(await mkdtemp(path.join(tmpdir(), "dozo-relay-store-")), "state");
});
afterEach(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

function entry(channel: string): RelayHostChannel {
  return {
    channel,
    relay: "https://relay.test",
    hostToken: "host-token",
    createdAt: 1,
    pairing: { psk: "A".repeat(43), expiresAt: 2 },
    app: null,
  };
}

const mode = async (file: string) => (await stat(file)).mode & 0o777;

describe("fileRelayStore", () => {
  it("keeps one file per channel, readable by the user only", async () => {
    const store = fileRelayStore(dir);
    expect(await store.list()).toEqual([]);
    await store.put(entry("Y2hhbm5lbC1vbmUtMTIzND"));
    await store.put({ ...entry("Y2hhbm5lbC1vbmUtMTIzND"), hostToken: "changed" });
    await store.put(entry("Y2hhbm5lbC10d28tMTIzND"));

    expect((await store.list()).map((item) => item.channel).sort()).toEqual([
      "Y2hhbm5lbC10d28tMTIzND",
      "Y2hhbm5lbC1vbmUtMTIzND",
    ]);
    const file = path.join(dir, "channels", "Y2hhbm5lbC1vbmUtMTIzND.json");
    expect(JSON.parse(await readFile(file, "utf8")).hostToken).toBe("changed");
    if (process.platform !== "win32") {
      expect(await mode(dir)).toBe(0o700);
      expect(await mode(path.join(dir, "channels"))).toBe(0o700);
      expect(await mode(file)).toBe(0o600);
    }
    expect(await readdir(path.join(dir, "channels"))).toHaveLength(2);

    await store.remove("Y2hhbm5lbC1vbmUtMTIzND");
    await store.remove("Y2hhbm5lbC1vbmUtMTIzND");
    expect(await store.list()).toHaveLength(1);
  });

  it("keeps the user's approval of a phone", async () => {
    const store = fileRelayStore(dir);
    const paired: RelayHostChannel = {
      ...entry("Y2hhbm5lbC1vbmUtMTIzND"),
      pairing: null,
      app: {
        key: encodeRelayBytes(crypto.randomBytes(32)),
        pairingKey: encodeRelayBytes(crypto.randomBytes(32)),
        verifierSet: true,
        pairedAt: 1,
        approvedAt: 2,
      },
    };
    await store.put(paired);
    expect((await store.list())[0]?.app?.approvedAt).toBe(2);
  });

  it("keeps an approval when run then writes the copy of the channel it read before it", async () => {
    const store = fileRelayStore(dir);
    const channel = "Y2hhbm5lbC10d28tMTIzND";
    const unapproved: RelayHostChannel = {
      ...entry(channel),
      pairing: null,
      app: {
        key: encodeRelayBytes(crypto.randomBytes(32)),
        pairingKey: encodeRelayBytes(crypto.randomBytes(32)),
        verifierSet: false,
        pairedAt: 1,
        approvedAt: null,
      },
    };
    await store.put(unapproved);
    await store.approve(channel, 7);
    // run's own write after its verifier is set, from the entry it held before the approval.
    await store.put({ ...unapproved, app: { ...unapproved.app!, verifierSet: true } });
    expect((await store.list())[0]?.app).toMatchObject({ verifierSet: true, approvedAt: 7 });
    await store.remove(channel);
    expect(await readdir(path.join(dir, "channels"))).toEqual([]);
  });

  it("makes the host key once, even when asked twice at the same time", async () => {
    const first = fileRelayStore(dir);
    const second = fileRelayStore(dir);
    const create = vi.fn(() => crypto.generateKeyPair());
    const [a, b] = await Promise.all([first.hostKey(create), second.hostKey(create)]);
    expect(a).toEqual(b);
    expect(await first.hostKey(create)).toEqual(a);
    if (process.platform !== "win32")
      expect(await mode(path.join(dir, "host-key.json"))).toBe(0o600);
  });

  it("refuses a channel id that is not one and a file it cannot read", async () => {
    const store = fileRelayStore(dir);
    await expect(store.put(entry("../escape"))).rejects.toThrow("not a channel id");
    await expect(store.remove("../escape")).rejects.toThrow("not a channel id");

    await mkdir(path.join(dir, "channels"), { recursive: true });
    await writeFile(path.join(dir, "channels", ".partial.json.tmp"), "{");
    await writeFile(path.join(dir, "channels", "notes.txt"), "x");
    expect(await store.list()).toEqual([]);
    await writeFile(path.join(dir, "channels", "Y2hhbm5lbC1vbmUtMTIzND.json"), "{}");
    await expect(store.list()).rejects.toThrow(
      "Y2hhbm5lbC1vbmUtMTIzND.json is not a relay channel",
    );
    await writeFile(path.join(dir, "host-key.json"), "[]");
    await expect(store.hostKey(() => crypto.generateKeyPair())).rejects.toThrow(
      "host-key.json is not a key pair",
    );
  });

  it("reports a channels folder it cannot read", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "channels"), "not a folder");
    await expect(fileRelayStore(dir).list()).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("tells a watcher when another process changes a channel", async () => {
    const store = fileRelayStore(dir);
    const onChange = vi.fn();
    const stop = store.watch?.(onChange);
    await fileRelayStore(dir).put(entry("Y2hhbm5lbC1vbmUtMTIzND"));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    stop?.();
  });

  it("moves a file into place again while Windows refuses it for a moment, and only then", async () => {
    const busy = (code: string) => Object.assign(new Error(code), { code });
    const moves: string[] = [];
    await replaceFile("a.tmp", "a.json", async (from) => {
      moves.push(from);
      if (moves.length < 3) throw busy("EPERM");
    });
    expect(moves).toHaveLength(3);
    const missing = replaceFile("b.tmp", "b.json", async () => {
      throw busy("ENOENT");
    });
    await expect(missing).rejects.toThrow("ENOENT");
    const odd = replaceFile("c.tmp", "c.json", async () => {
      throw new Error("no code");
    });
    await expect(odd).rejects.toThrow("no code");
  });
});
