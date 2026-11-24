import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailEmulator, FakeSandboxProvider, InMemoryRealtimeFanout } from "@rakazo/adapters";
import {
  appendEventInTransaction,
  asSystem,
  createThreadMessageInTransaction,
  notifyRealtime,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import type { AppHandles } from "./app.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const webOrigin = "http://127.0.0.1:5173";

/**
 * A password change signs out every other session whether or not the client asks: the auth
 * library does so only when the request says `revokeOtherSessions`, and a client that leaves it
 * out would leave a taken-over session signed in with the new password.
 */
describe.skipIf(!databaseUrl)("a password change signs out the other sessions", () => {
  let handles: AppHandles;
  let dataDir: string;
  const realtime = new InMemoryRealtimeFanout();
  const streams: AbortController[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "dozo-password-change-"));
    handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      sandbox: new FakeSandboxProvider(),
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin,
      authUrl: webOrigin,
      email: new EmailEmulator(),
      realtime,
    });
  });

  afterAll(async () => {
    for (const stream of streams) stream.abort();
    await handles?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function auth(path: string, body: object, cookie = "") {
    return handles.app.request(`/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: webOrigin,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  /** A chat stream as the app opens it, collecting the raw frames as they arrive. */
  async function follow(cookie: string, botId: string) {
    const controller = new AbortController();
    streams.push(controller);
    const response = await handles.app.request("/rpc/threads/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", origin: webOrigin, cookie },
      body: JSON.stringify({ json: { botId, cursor: -1 } }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const stream = { text: "", ended: false };
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          stream.text += decoder.decode(value, { stream: true });
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        stream.ended = true;
      }
    })();
    return stream;
  }

  it("without the client asking, and ends their open streams", async () => {
    const system = asSystem(handles.prisma);
    const address = `password-change-${Date.now()}@example.test`;
    const password = "test-password-123";
    expect((await auth("/sign-up/email", { email: address, password, name: "Ada" })).status).toBe(
      200,
    );
    const signIn = async () => {
      const response = await auth("/sign-in/email", { email: address, password });
      expect(response.status, await response.clone().text()).toBe(200);
      return sessionCookieHeader(response);
    };
    // As the mailed link does.
    const user = await system.user.update({
      where: { email: address },
      data: { emailVerified: true },
    });
    const changer = await signIn();
    const other = await signIn();
    const { spaceId } = await system.spaceMember.findFirstOrThrow({ where: { userId: user.id } });
    const computer = await system.computer.create({
      data: {
        spaceId,
        userId: user.id,
        scopeKey: spaceId,
        homeKey: spaceId,
        kind: "fake",
        state: "running",
      },
    });
    const bot = await system.bot.create({
      data: { spaceId, userId: user.id, name: "Chef", color: "test", computerId: computer.id },
    });
    const thread = await system.thread.create({
      data: { spaceId, userId: user.id, botId: bot.id },
    });
    /** A bot reply in the chat, as a run leaves it and tells the chat's followers. */
    const botSays = async (text: string) => {
      const event = await system.$transaction(async (tx) => {
        const blocks = [{ kind: "text" as const, text }];
        const message = await createThreadMessageInTransaction(tx, {
          threadId: thread.id,
          role: "bot",
          botId: bot.id,
          blocks,
        });
        return appendEventInTransaction(tx, {
          spaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "thread.message.created",
          payload: { messageId: message.id, role: "bot", blocks },
        });
      });
      await notifyRealtime(realtime, thread.id, event.seq);
    };
    const before = await system.session.findMany({ where: { userId: user.id } });
    expect(before.length).toBeGreaterThanOrEqual(2);
    const stream = await follow(other, bot.id);
    await botSays("before the change");
    await vi.waitFor(() => expect(stream.text).toContain("before the change"), { timeout: 5_000 });

    const changed = await auth(
      "/change-password",
      { currentPassword: password, newPassword: "test-password-456" },
      changer,
    );
    expect(changed.status, await changed.clone().text()).toBe(200);

    // Every session from before the change is gone; the one that made it goes on as a new one.
    const after = await system.session.findMany({ where: { userId: user.id } });
    const left = after.map((session) => session.id);
    for (const session of before) expect(left).not.toContain(session.id);
    expect(left).toHaveLength(1);
    const kept = await handles.app.request("/api/auth/get-session", {
      headers: { origin: webOrigin, cookie: sessionCookieHeader(changed) },
    });
    expect(((await kept.json()) as { user?: { id: string } } | null)?.user?.id).toBe(user.id);

    // The other session's open stream ends before the next message reaches it.
    await botSays("after the change");
    await vi.waitFor(
      () => expect(stream.ended || stream.text.includes("after the change")).toBe(true),
      {
        timeout: 3_000,
      },
    );
    expect(stream.text).not.toContain("after the change");
    expect(stream.text).toMatch(/event: error[\s\S]*UNAUTHORIZED/);
  });
});
