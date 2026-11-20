import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, watch } from "node:fs";
import { chmod, link, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { RelayChannelId, RelayKey } from "@rakazo/contracts";
import type { RelayHostChannel, RelayHostStore, RelayKeyPair } from "@rakazo/core";
import { decodeRelayBytes, encodeRelayBytes } from "@rakazo/core";
import * as z from "zod";

/**
 * The host agent's state on disk: `host-key.json` (the long-term key pair) and one
 * `channels/<id>.json` per channel, so processes that pair, run and revoke at once never write the
 * same file. Directories are the user's only (0700), files too (0600); every write is a new file
 * renamed into place. Layout: `dozo/relay/agent/README.md`.
 */

const ChannelSchema = z.object({
  channel: RelayChannelId,
  relay: z.string(),
  hostToken: z.string(),
  createdAt: z.number(),
  pairing: z.object({ psk: RelayKey, expiresAt: z.number() }).nullable(),
  app: z
    .object({
      key: RelayKey,
      pairingKey: RelayKey,
      verifierSet: z.boolean(),
      pairedAt: z.number(),
    })
    .nullable(),
});
const KeyPairSchema = z.object({ publicKey: RelayKey, privateKey: RelayKey });

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

export function fileRelayStore(dir: string): RelayHostStore {
  const channelsDir = path.join(dir, "channels");
  const hostKeyFile = path.join(dir, "host-key.json");
  const channelFile = (channel: string) => {
    if (!RelayChannelId.safeParse(channel).success) throw new Error(`not a channel id: ${channel}`);
    return path.join(channelsDir, `${channel}.json`);
  };
  const ensureDirs = async () => {
    for (const each of [dir, channelsDir]) {
      await mkdir(each, { recursive: true, mode: PRIVATE_DIR });
      await chmod(each, PRIVATE_DIR);
    }
  };

  const readKeyPair = async (): Promise<RelayKeyPair> => {
    const parsed = KeyPairSchema.safeParse(JSON.parse(await readFile(hostKeyFile, "utf8")));
    if (!parsed.success) throw new Error(`${hostKeyFile} is not a key pair`);
    return {
      publicKey: decodeRelayBytes(parsed.data.publicKey),
      privateKey: decodeRelayBytes(parsed.data.privateKey),
    };
  };

  return {
    async hostKey(create) {
      try {
        return await readKeyPair();
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await ensureDirs();
      const pair = await create();
      const temp = await writePrivate(hostKeyFile, {
        publicKey: encodeRelayBytes(pair.publicKey),
        privateKey: encodeRelayBytes(pair.privateKey),
      });
      // A hard link fails when the name exists: two processes starting together keep one key.
      try {
        await link(temp, hostKeyFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        await rm(temp, { force: true });
      }
      return readKeyPair();
    },

    async list() {
      let names: string[];
      try {
        names = await readdir(channelsDir);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const channels: RelayHostChannel[] = [];
      for (const name of names) {
        if (name.startsWith(".") || !name.endsWith(".json")) continue;
        const file = path.join(channelsDir, name);
        const parsed = ChannelSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
        if (!parsed.success) throw new Error(`${file} is not a relay channel`);
        channels.push(parsed.data);
      }
      return channels;
    },

    async put(channel) {
      const file = channelFile(channel.channel);
      await ensureDirs();
      await rename(await writePrivate(file, channel), file);
    },

    async remove(channel) {
      await rm(channelFile(channel), { force: true });
    },

    watch(onChange) {
      for (const each of [dir, channelsDir]) {
        mkdirSync(each, { recursive: true, mode: PRIVATE_DIR });
        chmodSync(each, PRIVATE_DIR);
      }
      const watcher = watch(channelsDir, () => onChange());
      return () => watcher.close();
    },
  };
}

/** Writes `value` to a new hidden file next to `file`, flushed to disk; returns its path. */
async function writePrivate(file: string, value: unknown) {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temp, "wx", PRIVATE_FILE);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
