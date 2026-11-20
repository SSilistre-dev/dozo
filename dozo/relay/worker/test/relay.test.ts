import {
  createExecutionContext,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { RELAY_MAX_MESSAGE_BYTES } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Channel, ChannelRecord } from "../src/channel.js";
import { CLOSE_DELETED, PAIR_GRACE_MS } from "../src/channel.js";
import { createRelay } from "../src/index.js";
import type { Registry } from "../src/registry.js";
import {
  call,
  channelStub,
  confirmPairing,
  connect,
  newAddress,
  peer,
  register,
  registryStub,
  token,
  upgrade,
  waitForClose,
  waitForText,
} from "./support.js";

const bytes = (...values: number[]) => new Uint8Array(values);

async function pairedChannel() {
  const registered = await register();
  const appToken = await confirmPairing(registered);
  const host = await connect(registered.channel, "host", registered.hostToken);
  const app = await connect(registered.channel, "app", appToken);
  await waitForText(host, peer(true));
  return { ...registered, appToken, host, app };
}

async function record(channel: string) {
  return runInDurableObject(channelStub(channel), (_: Channel, state) =>
    state.storage.get<ChannelRecord>("record"),
  );
}

async function channelCount() {
  return runInDurableObject(registryStub(), (registry: Registry) => registry.count());
}

describe("register, pair and relay", () => {
  it("registers, pairs with the pairing token and carries binary both ways, in order", async () => {
    const registered = await register();
    expect(registered.channel).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const host = await connect(registered.channel, "host", registered.hostToken);
    await waitForText(host, peer(false));
    const app = await connect(registered.channel, "app", registered.pairToken);
    await waitForText(app, peer(true));
    await waitForText(host, peer(true));

    app.ws.send(bytes(1, 2, 3));
    app.ws.send(bytes(4));
    host.ws.send(bytes(9, 9));
    await vi.waitFor(() => expect(host.binaries).toEqual([bytes(1, 2, 3), bytes(4)]));
    await vi.waitFor(() => expect(app.binaries).toEqual([bytes(9, 9)]));
  });

  it("stores verifiers and timestamps only, never a token", async () => {
    const registered = await register();
    const stored = await record(registered.channel);
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      [
        "appVerifier",
        "createdAt",
        "hostVerifier",
        "id",
        "pairExpiresAt",
        "pairVerifier",
        "seenAt",
      ].sort(),
    );
    expect(JSON.stringify(stored)).not.toContain(registered.hostToken);
    expect(JSON.stringify(stored)).not.toContain(registered.pairToken);
  });

  it("swaps the pairing verifier for the app's once the host confirms", async () => {
    const registered = await register();
    const appToken = await confirmPairing(registered);
    expect((await upgrade(registered.channel, "app", registered.pairToken)).status).toBe(404);
    expect((await upgrade(registered.channel, "app", appToken)).status).toBe(101);
    const stored = await record(registered.channel);
    expect(stored?.pairVerifier).toBeNull();
  });

  it("drops binary when the other end is not connected", async () => {
    const { channel, hostToken } = await register();
    const host = await connect(channel, "host", hostToken);
    host.ws.send(bytes(1));
    await waitForText(host, peer(false));
    expect(host.closed).toBeNull();
  });

  it("answers ping with pong without waking the object's handlers", async () => {
    const { host } = await pairedChannel();
    host.ws.send("ping");
    await waitForText(host, "pong");
    expect(host.closed).toBeNull();
  });
});

describe("one answer for every refusal", () => {
  it("answers a wrong token and an unknown channel with the same empty 404", async () => {
    const registered = await register();
    const unknown = "A".repeat(22);
    const answers = await Promise.all([
      upgrade(registered.channel, "host", token()),
      upgrade(registered.channel, "host", registered.pairToken),
      upgrade(unknown, "host", registered.hostToken),
      upgrade(registered.channel, "app", registered.hostToken),
      call(`/v1/channels/${registered.channel}`, { method: "DELETE", token: token() }),
      call(`/v1/channels/${unknown}`, { method: "DELETE", token: registered.hostToken }),
      call(`/v1/channels/${registered.channel}/app`, {
        method: "PUT",
        token: registered.pairToken,
        body: "{}",
      }),
      upgrade(registered.channel, "host", ""),
      upgrade("not-a-channel", "host", registered.hostToken),
      call("/v1/elsewhere"),
      call(`/v1/channels/${registered.channel}/host`, { token: registered.hostToken }),
    ]);
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(await answer.text()).toBe("");
      expect([...answer.headers.keys()].sort()).toEqual(["cache-control"]);
    }
  });

  it("refuses the pairing token once the offer expired", async () => {
    const registered = await register({ pairExpiresAt: Date.now() + 1000 });
    await runInDurableObject(channelStub(registered.channel), async (_: Channel, state) => {
      const stored = await state.storage.get<ChannelRecord>("record");
      await state.storage.put("record", { ...stored, pairExpiresAt: Date.now() - 1 });
    });
    await evictDurableObject(channelStub(registered.channel));
    expect((await upgrade(registered.channel, "app", registered.pairToken)).status).toBe(404);
  });

  it("answers 400 for a body that does not parse or an offer that outlives the pairing TTL", async () => {
    const bodies = [
      "not json",
      "{}",
      JSON.stringify({ hostVerifier: "x", pairVerifier: "y", pairExpiresAt: Date.now() + 1000 }),
      JSON.stringify({
        hostVerifier: "A".repeat(43),
        pairVerifier: "A".repeat(43),
        pairExpiresAt: Date.now() - 1,
      }),
      JSON.stringify({
        hostVerifier: "A".repeat(43),
        pairVerifier: "A".repeat(43),
        pairExpiresAt: Date.now() + 60 * 60 * 1000,
      }),
      "x".repeat(5000),
    ];
    for (const body of bodies) {
      expect((await call("/v1/channels", { method: "POST", body })).status).toBe(400);
    }
  });

  it("refuses a registration the admission step turns down with 404", async () => {
    const relay = createRelay(() => false);
    const request = new Request("https://relay.test/v1/channels", {
      method: "POST",
      headers: { "CF-Connecting-IP": newAddress() },
      body: JSON.stringify({
        hostVerifier: "A".repeat(43),
        pairVerifier: "A".repeat(43),
        pairExpiresAt: Date.now() + 1000,
      }),
    });
    const response = await relay.fetch!(
      request as Request<unknown, IncomingRequestCfProperties>,
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
  });
});

// Tens of sequential requests each: slow on a shared machine, not stuck.
describe("limits", { timeout: 30_000 }, () => {
  it("limits registrations per address and says when to retry", async () => {
    const address = newAddress();
    for (let i = 0; i < 30; i += 1) await register({ address });
    const refused = await call("/v1/channels", { method: "POST", address, body: "{}" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    await register();
  });

  it("limits channel requests per address", async () => {
    const address = newAddress();
    const statuses: number[] = [];
    for (let i = 0; i < 121; i += 1) {
      statuses.push((await upgrade("A".repeat(22), "host", token(), address)).status);
    }
    expect(statuses.slice(0, 120).every((status) => status === 404)).toBe(true);
    expect(statuses[120]).toBe(429);
  });

  it("limits wrong tokens per channel without locking out the ends", async () => {
    const { channel, hostToken } = await register();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await upgrade(channel, "app", token())).status);
    expect(statuses.slice(0, 60).every((status) => status === 404)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect((await upgrade(channel, "host", hostToken)).status).toBe(101);
  });

  it("limits the ends' own requests per channel", async () => {
    const { channel, hostToken } = await register();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1)
      statuses.push((await upgrade(channel, "host", hostToken)).status);
    expect(statuses.slice(0, 60).every((status) => status === 101)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("stops reading a body past its size limit, declared or not", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1024));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await call("/v1/channels", { method: "POST", body });
    expect(response.status).toBe(400);
    expect(pulled).toBeLessThan(100);
  });

  it("closes a socket that sends more than one record's worth with 1009", async () => {
    const { app, host } = await pairedChannel();
    app.ws.send(new Uint8Array(RELAY_MAX_MESSAGE_BYTES));
    await vi.waitFor(() => expect(host.binaries).toHaveLength(1));
    app.ws.send(new Uint8Array(RELAY_MAX_MESSAGE_BYTES + 1));
    expect((await waitForClose(app)).code).toBe(1009);
    expect(host.binaries).toHaveLength(1);
  });

  it("closes a socket that sends text other than ping with 1003", async () => {
    const { app } = await pairedChannel();
    app.ws.send("hello");
    expect((await waitForClose(app)).code).toBe(1003);
  });

  it("closes a socket past the channel's messages per minute with 1008", async () => {
    const { app, host } = await pairedChannel();
    for (let i = 0; i < 3001; i += 1) app.ws.send(bytes(i % 256));
    expect((await waitForClose(app)).code).toBe(1008);
    expect(host.binaries).toHaveLength(3000);
  });

  it("refuses registrations over the channel ceiling until one is deleted", async () => {
    const existing = await channelCount();
    const ceiling = existing + 1;
    const limited = { ...env, MAX_CHANNELS: String(ceiling) };
    const relay = createRelay(() => true);
    const registerBody = () =>
      JSON.stringify({
        hostVerifier: "A".repeat(43),
        pairVerifier: "A".repeat(43),
        pairExpiresAt: Date.now() + 1000,
      });
    const post = () =>
      relay.fetch!(
        new Request("https://relay.test/v1/channels", {
          method: "POST",
          headers: { "CF-Connecting-IP": newAddress() },
          body: registerBody(),
        }) as Request<unknown, IncomingRequestCfProperties>,
        limited,
        createExecutionContext(),
      );
    expect((await post()).status).toBe(201);
    expect(await channelCount()).toBe(ceiling);
    expect((await post()).status).toBe(429);

    const { channel, hostToken } = await register();
    expect(
      (await call(`/v1/channels/${channel}`, { method: "DELETE", token: hostToken })).status,
    ).toBe(204);
    await call(`/v1/channels/${channel}`, { method: "DELETE", token: hostToken });
    expect(await channelCount()).toBe(ceiling);
  });
});

describe("expiry and revocation", () => {
  it("deletes a channel nobody paired once the offer and its grace are over", async () => {
    const registered = await register({ pairExpiresAt: Date.now() + 1000 });
    const host = await connect(registered.channel, "host", registered.hostToken);
    const before = await channelCount();

    expect(await runDurableObjectAlarm(channelStub(registered.channel))).toBe(true);
    expect(await record(registered.channel)).toBeDefined();

    await runInDurableObject(channelStub(registered.channel), async (_: Channel, state) => {
      const stored = await state.storage.get<ChannelRecord>("record");
      await state.storage.put("record", {
        ...stored,
        pairExpiresAt: Date.now() - PAIR_GRACE_MS - 1,
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(channelStub(registered.channel));
    expect(await runDurableObjectAlarm(channelStub(registered.channel))).toBe(true);
    expect((await waitForClose(host)).code).toBe(CLOSE_DELETED);
    expect(await record(registered.channel)).toBeUndefined();
    expect(await channelCount()).toBe(before - 1);
    expect((await upgrade(registered.channel, "host", registered.hostToken)).status).toBe(404);
  });

  it("deletes a paired channel nobody connected to for the idle period", async () => {
    const registered = await register();
    await confirmPairing(registered);
    await runInDurableObject(channelStub(registered.channel), async (_: Channel, state) => {
      const stored = await state.storage.get<ChannelRecord>("record");
      await state.storage.put("record", { ...stored, seenAt: Date.now() - 181 * 86_400_000 });
    });
    await evictDurableObject(channelStub(registered.channel));
    expect(await runDurableObjectAlarm(channelStub(registered.channel))).toBe(true);
    expect(await record(registered.channel)).toBeUndefined();
  });

  it("keeps a paired channel that is connected when its alarm fires", async () => {
    const { channel } = await pairedChannel();
    const before = (await record(channel))!.seenAt;
    await runInDurableObject(channelStub(channel), async (_: Channel, state) => {
      const stored = await state.storage.get<ChannelRecord>("record");
      await state.storage.put("record", { ...stored, seenAt: before - 181 * 86_400_000 });
    });
    await evictDurableObject(channelStub(channel));
    expect(await runDurableObjectAlarm(channelStub(channel))).toBe(true);
    expect((await record(channel))!.seenAt).toBeGreaterThanOrEqual(before);
    const alarm = await runInDurableObject(channelStub(channel), (_: Channel, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeGreaterThan(Date.now() + 170 * 86_400_000);
  });

  it("closes both sockets and forgets the channel when either end deletes it", async () => {
    for (const by of ["host", "app"] as const) {
      const paired = await pairedChannel();
      const bearer = by === "host" ? paired.hostToken : paired.appToken;
      const response = await call(`/v1/channels/${paired.channel}`, {
        method: "DELETE",
        token: bearer,
      });
      expect(response.status).toBe(204);
      expect((await waitForClose(paired.host)).code).toBe(CLOSE_DELETED);
      expect((await waitForClose(paired.app)).code).toBe(CLOSE_DELETED);
      expect((await upgrade(paired.channel, "host", paired.hostToken)).status).toBe(404);
      expect((await upgrade(paired.channel, "app", paired.appToken)).status).toBe(404);
    }
  });

  it("closes the old phone's socket when the host pairs a new one", async () => {
    const paired = await pairedChannel();
    const newToken = await confirmPairing(paired);
    expect((await waitForClose(paired.app)).code).toBe(CLOSE_DELETED);
    expect((await upgrade(paired.channel, "app", paired.appToken)).status).toBe(404);
    expect((await upgrade(paired.channel, "app", newToken)).status).toBe(101);
    expect(paired.host.closed).toBeNull();
  });

  it("does not let the pairing token delete a channel", async () => {
    const { channel, pairToken } = await register();
    expect(
      (await call(`/v1/channels/${channel}`, { method: "DELETE", token: pairToken })).status,
    ).toBe(404);
  });
});

describe("reconnects and hibernation", () => {
  it("replaces an older socket of the same role with code 4000 and tells the peer", async () => {
    const { channel, hostToken, host, app } = await pairedChannel();
    const again = await connect(channel, "host", hostToken);
    expect((await waitForClose(host)).code).toBe(4000);
    await waitForText(again, peer(true));
    await waitForText(app, peer(true), 2);
    app.ws.send(bytes(7));
    await vi.waitFor(() => expect(again.binaries).toEqual([bytes(7)]));
    expect(host.binaries).toEqual([]);
  });

  it("tells the peer when the other end goes away and comes back", async () => {
    const { channel, appToken, host, app } = await pairedChannel();
    app.ws.close(1000, "bye");
    await waitForText(host, peer(false));
    const back = await connect(channel, "app", appToken);
    await waitForText(back, peer(true));
    await waitForText(host, peer(true), 2);
  });

  it("keeps relaying and keeps the channel after the object hibernates", async () => {
    const { channel, host, app } = await pairedChannel();
    await evictDurableObject(channelStub(channel));
    app.ws.send(bytes(5, 5));
    host.ws.send(bytes(6));
    await vi.waitFor(() => expect(host.binaries).toEqual([bytes(5, 5)]));
    await vi.waitFor(() => expect(app.binaries).toEqual([bytes(6)]));
    host.ws.send("ping");
    await waitForText(host, "pong");

    await evictDurableObject(channelStub(channel));
    app.ws.close(1000, "bye");
    await waitForText(host, peer(false));
    expect((await upgrade(channel, "host", token())).status).toBe(404);
    expect((await record(channel))?.hostVerifier).toBeDefined();
    expect(host.closed).toBeNull();
  });
});
