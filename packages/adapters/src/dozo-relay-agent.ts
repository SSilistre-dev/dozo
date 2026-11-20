import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { RELAY_MAX_MESSAGE_BYTES } from "@rakazo/contracts";
import { isLoopbackHost } from "@rakazo/contracts/network-host";
import type { RelayWebSocket } from "@rakazo/core";
import {
  listRelayChannels,
  pairRelayHost,
  parseRetryAfter,
  RelayHttpError,
  relayPairingLink,
  revokeRelayChannel,
  runRelayHost,
  webRelayCrypto,
} from "@rakazo/core";
import WebSocket from "ws";
import { fileRelayStore } from "./dozo-relay-file-store.js";

/**
 * The host agent: the command the desktop app starts beside the local Dozo server so a paired
 * phone reaches it through a relay. Every line on stdout is one JSON object. Commands, events and
 * exit codes: `dozo/relay/agent/README.md`.
 */

export type RelayAgentIo = {
  write(line: string): void;
  /** Where state lives without `--state`. */
  stateDir: string;
  /** Stops `run`. */
  signal: AbortSignal;
  random?: () => number;
  now?: () => number;
};

const USAGE = 64;
const FAILED = 2;
const HANDSHAKE_TIMEOUT_MS = 15_000;

class UsageError extends Error {}

/** Runs one command and returns the exit code: 0 done, 2 failed, 64 usage error. */
export async function relayAgentMain(argv: string[], io: RelayAgentIo): Promise<number> {
  const emit = (value: unknown) => io.write(JSON.stringify(value));
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        state: { type: "string" },
        relay: { type: "string" },
        origin: { type: "string" },
      },
    });
    const [command, channel] = positionals;
    const store = fileRelayStore(values.state ?? io.stateDir);
    const crypto = webRelayCrypto();
    const now = io.now;
    switch (command) {
      case "pair": {
        if (!values.relay) throw new UsageError("pair needs --relay <https address>");
        const offer = await pairRelayHost({ store, crypto, relay: values.relay, now });
        emit({
          event: "offer",
          channel: offer.channel,
          relay: offer.relay,
          expiresAt: offer.expiresAt,
          qr: relayPairingLink(offer.offer),
        });
        return 0;
      }
      case "run": {
        const origin = loopbackOrigin(values.origin);
        await runRelayHost({
          store,
          crypto,
          origin,
          connect: connectRelaySocket,
          onEvent: emit,
          signal: io.signal,
          random: io.random,
          now,
        });
        emit({ event: "stopped" });
        return 0;
      }
      case "list":
        emit({ channels: await listRelayChannels(store) });
        return 0;
      case "revoke": {
        if (!channel) throw new UsageError("revoke needs a channel id");
        const result = await revokeRelayChannel({ store, crypto, channel });
        emit({ event: "revoked", channel, relay: result.relay });
        return 0;
      }
      default:
        throw new UsageError("commands: pair, run, list, revoke");
    }
  } catch (error) {
    emit({ event: "error", reason: (error as Error).message });
    return error instanceof UsageError || isArgError(error) ? USAGE : FAILED;
  }
}

/** The loopback origin `run` forwards to; anything else would make the agent an open proxy. */
function loopbackOrigin(value: string | undefined) {
  try {
    const url = new URL(value ?? "");
    if ((url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname))
      return url.origin;
  } catch {
    // reported below
  }
  throw new UsageError("--origin must be a loopback http address");
}

/** Where an app keeps its settings on each system; `--state` overrides it. */
export function defaultRelayStateDir(
  platform: string,
  env: Record<string, string | undefined>,
  home: string,
) {
  if (platform === "darwin")
    return path.join(home, "Library", "Application Support", "dozo", "relay");
  if (platform === "win32")
    return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "dozo", "relay");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "dozo", "relay");
}

/**
 * Opens a relay socket with the token in the upgrade's `Authorization` header. Wrap it with
 * `wsDuplex` in the same turn it resolves: messages flow from the next one.
 */
export function connectRelaySocket(
  url: string,
  token: string,
  signal: AbortSignal,
): Promise<RelayWebSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
      maxPayload: RELAY_MAX_MESSAGE_BYTES,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    const fail = (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      socket.terminate();
      reject(error);
    };
    const onAbort = () => fail(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("open", () => {
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners("error");
      // The relay's first message can arrive in the same turn as the open: hold it until the
      // caller, which wraps the socket as soon as this resolves, listens.
      socket.pause();
      resolve(socket);
      setImmediate(() => socket.resume());
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      const retryAfter = parseRetryAfter(response.headers["retry-after"]);
      fail(new RelayHttpError(Number(response.statusCode), retryAfter));
    });
    socket.on("error", fail);
  });
}

function isArgError(error: unknown) {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

/** Runs this process's command line; SIGINT and SIGTERM stop `run`. */
export function relayAgentProcess(
  proc: Pick<NodeJS.Process, "argv" | "env" | "once" | "platform" | "stdout">,
) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) proc.once(signal, () => controller.abort());
  return relayAgentMain(proc.argv.slice(2), {
    write: (line) => proc.stdout.write(`${line}\n`),
    signal: controller.signal,
    stateDir: defaultRelayStateDir(proc.platform, proc.env, homedir()),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await relayAgentProcess(process);
