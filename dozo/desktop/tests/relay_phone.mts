// The phone's end of tests/stack_e2e.sh: a dev relay on 127.0.0.1:8787, then a phone that waits
// for the QR text the app writes to <shared>/qr, pairs through it, fetches a page through the relay
// (status to <shared>/fetched), then asks for its sign-in: it writes the code it would show to
// <shared>/code, and once the app allowed it, the answer and the session's email to
// <shared>/signed-in. It keeps the
// relay up until killed, so the app can remove the phone afterwards.
// Usage: tsx relay_phone.mts <shared-dir> [--no-dev-relay], in a container that has the workspace at $DOZO_WORKSPACE
// (the relay code is imported from there, the same files the bundled agent was built from).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const workspace = process.env.DOZO_WORKSPACE ?? "/w";
const shared = process.argv[2] ?? "";
const say = (line: string) => process.stdout.write(`[phone] ${line}\n`);

// As file URLs: an absolute Windows path is not a module address.
const from = (file: string) => pathToFileURL(path.join(workspace, file)).href;
const core = await import(from("packages/core/src/index.ts"));
const { startDevRelay } = await import(from("packages/adapters/src/dozo-relay-dev-relay.ts"));
const { connectRelaySocket } = await import(from("packages/adapters/src/dozo-relay-agent.ts"));

// With --no-dev-relay the phone uses whatever relay the pairing link names (the canary's real one).
if (!process.argv.includes("--no-dev-relay")) {
  const relay = await startDevRelay({ port: 8787 });
  say(`relay at ${relay.url}`);
}

let qr = "";
for (let tries = 0; !qr && tries < 1200; tries++) {
  qr = await readFile(path.join(shared, "qr"), "utf8").catch(() => "");
  if (!qr) await sleep(500);
}
if (!qr.startsWith("rakazo://dozo-pair#")) throw new Error(`no pairing link: ${qr}`);
const crypto = core.webRelayCrypto();
const offer = core.parseRelayPairingOffer(qr.slice(qr.indexOf("#") + 1), Date.now());
const { psk, token } = await core.relayPairingSecrets(crypto, core.decodeRelayBytes(offer.secret));
const appKey = await crypto.generateKeyPair();
const hostKey = core.decodeRelayBytes(offer.hostKey);
const socket = await connectRelaySocket(
  `${offer.relay.replace(/^http/, "ws")}/v1/channels/${offer.channel}/app`,
  token,
  new AbortController().signal,
);
const sealed = await new Promise((resolve, reject) => {
  core.wsDuplex(socket, {
    role: "app",
    onSession: (transport: unknown) => {
      core
        .openAppChannel({ crypto, transport, channel: offer.channel, psk, appKey, hostKey })
        .then(resolve, reject);
    },
  });
});
const client = core.relayClient(sealed);
const response = await client.fetch("/api/auth/get-session");
say(`paired on ${offer.channel}; GET /api/auth/get-session through the relay: ${response.status}`);
await writeFile(path.join(shared, "fetched"), String(response.status));
// Its sign-in: the code it would show, then the request the computer holds until the person
// there allows this phone, then the session it gets.
const code = await core.relayApprovalCode(
  crypto,
  (sealed as { pairingKey: Uint8Array }).pairingKey,
);
await writeFile(path.join(shared, "code"), String(code));
say(`shows the code ${code} and asks for its sign-in`);
const asked = await client.fetch("/api/auth/dozo/relay-session", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ platform: "android" }),
});
const { token: session } = (await asked.json()) as { token?: string };
const me = await client.fetch("/api/auth/get-session", {
  headers: { authorization: `Bearer ${session}` },
});
const email = ((await me.json()) as { user?: { email?: string } } | null)?.user?.email;
say(`sign-in ${asked.status}, session of ${email}`);
await writeFile(path.join(shared, "signed-in"), `${asked.status} ${email}`);
client.close();
socket.close();
await sleep(600_000);
