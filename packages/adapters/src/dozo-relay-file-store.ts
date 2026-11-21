import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, watch } from "node:fs";
import { chmod, link, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { RelayChannelId, RelayKey } from "@rakazo/contracts";
import type { RelayHostChannel, RelayHostStore, RelayKeyPair } from "@rakazo/core";
import { decodeRelayBytes, encodeRelayBytes, retry } from "@rakazo/core";
import * as z from "zod";

/**
 * The host agent's state on disk: `host-key.json` (the long-term key pair) and one
 * `channels/<id>.json` per channel, so processes that pair, run and revoke at once never write the
 * same file; the user's approval of a channel's phone is `channels/<id>.approved`, which only
 * `approve` writes, so `run` rewriting the channel never undoes it. Directories are the user's only (0700), files too (0600); every write is a new file
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
      /** When the user approved the phone on the computer (`approve`). */
      approvedAt: z.number().nullable().optional(),
    })
    .nullable(),
});
const KeyPairSchema = z.object({ publicKey: RelayKey, privateKey: RelayKey });
const ApprovalSchema = z.object({ approvedAt: z.number() });

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

export function fileRelayStore(dir: string): RelayHostStore {
  const channelsDir = path.join(dir, "channels");
  const hostKeyFile = path.join(dir, "host-key.json");
  const channelFile = (channel: string) => {
    if (!RelayChannelId.safeParse(channel).success) throw new Error(`not a channel id: ${channel}`);
    return path.join(channelsDir, `${channel}.json`);
  };
  const approvalFile = (channel: string) => channelFile(channel).replace(/\.json$/, ".approved");
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

  const readApproval = async (channel: string) => {
    try {
      const parsed = ApprovalSchema.safeParse(
        JSON.parse(await readFile(approvalFile(channel), "utf8")),
      );
      if (!parsed.success) throw new Error(`${approvalFile(channel)} is not an approval`);
      return parsed.data.approvedAt;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
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
        const { app } = parsed.data;
        if (app && !app.approvedAt)
          app.approvedAt = (await readApproval(parsed.data.channel)) ?? app.approvedAt;
        channels.push(parsed.data);
      }
      return channels;
    },

    async put(channel) {
      const file = channelFile(channel.channel);
      await ensureDirs();
      await replaceFile(await writePrivate(file, channel), file);
    },

    async approve(channel, approvedAt) {
      const file = approvalFile(channel);
      await ensureDirs();
      await replaceFile(await writePrivate(file, { approvedAt }), file);
    },

    async remove(channel) {
      await rm(channelFile(channel), { force: true });
      await rm(approvalFile(channel), { force: true });
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

/**
 * Moves a new file over `to`. Windows refuses that for a moment while another process (`run`
 * reading the channel it was told about) has `to` open: asked again for about two seconds.
 */
export async function replaceFile(
  from: string,
  to: string,
  move: (from: string, to: string) => Promise<void> = rename,
) {
  await retry(() => move(from, to), {
    attempts: 20,
    delayMs: 100,
    retryable: (error) =>
      ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? ""),
  });
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
