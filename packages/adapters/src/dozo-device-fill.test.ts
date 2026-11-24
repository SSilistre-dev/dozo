import { beforeEach, describe, expect, it, vi } from "vitest";

const resolved = vi.hoisted(() => ({ resolveLoginFill: vi.fn(), recordVaultUse: vi.fn() }));
vi.mock("./bot-secrets.js", () => ({ resolveLoginFill: resolved.resolveLoginFill }));
vi.mock("./run-context.js", () => ({ recordVaultUse: resolved.recordVaultUse }));

import { DeviceBrowserProvider } from "./dozo-device-browser.js";
import { deviceFillOptions } from "./dozo-device-fill.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { LOGIN_CODE_FIELD } from "./vault-card-use.js";

const used = { id: "login-1", name: "work", spaceId: null, kind: "login" };
const linked = {
  text: "",
  hidden: true,
  origin: "https://example.test",
  sites: ["https://example.test"],
  redactions: [],
  used,
  deviceLogin: { handle: "AbCdEfGhIjKlMnOpQrStUv", field: "password" },
};

function setup() {
  const ctx = {
    deps: { prisma: { id: "prisma" }, secretStore: { id: "store" } },
    run: { id: "run-1", userId: "user-1", spaceId: "space-1", botId: "bot-1" },
    state: { pageUrl: "https://example.test/in" },
  } as unknown as RunContext;
  const approval = {
    kind: "login",
    login: "work",
    site: "https://example.test",
    fields: ["Password"],
  };
  const call = {
    name: "browser_act",
    args: { loginApproval: { ...approval, title: "", savedAt: "2026-09-01T00:00:00.000Z" } },
  } as unknown as ToolCall;
  const browser = new DeviceBrowserProvider(async () => ({}));
  return { ctx, call, browser, ...deviceFillOptions(ctx, call, "device-1", browser) };
}

beforeEach(() => {
  resolved.resolveLoginFill.mockReset().mockResolvedValue(linked);
  resolved.recordVaultUse.mockReset().mockResolvedValue(undefined);
});

describe("filling a linked login in the user's browser", () => {
  it("asks the vault as the bot's own computer does, naming this computer", async () => {
    const { resolveSecretFill, ctx, call } = setup();
    const fill = await resolveSecretFill(
      { kind: "fill_secret", ref: "e1", secret: "work", field: "Password" },
      0,
    );
    expect(resolved.resolveLoginFill).toHaveBeenCalledWith({
      prisma: ctx.deps.prisma,
      secretStore: ctx.deps.secretStore,
      scope: ctx.run,
      runId: "run-1",
      name: "work",
      field: "Password",
      approval: expect.objectContaining({ login: "work", site: "https://example.test" }),
      pageUrl: "https://example.test/in",
      deviceId: "device-1",
    });
    expect(fill).toMatchObject({ origin: "https://example.test", hidden: true });
    // The step carries a key of the browser, not the handle and not a value.
    expect((fill as { text: string }).text).toMatch(/^dozo-device-fill:/);
    expect(JSON.stringify(fill)).not.toContain(linked.deviceLogin.handle);
    expect(resolved.recordVaultUse).not.toHaveBeenCalled();
    await (fill as { typed: () => Promise<void> }).typed();
    expect(resolved.recordVaultUse).toHaveBeenCalledWith(
      ctx,
      call.name,
      used,
      "https://example.test",
    );
  });

  it("asks for a code by the login's code field, and takes and gives nothing back", async () => {
    resolved.resolveLoginFill.mockResolvedValue({
      ...linked,
      deviceLogin: { ...linked.deviceLogin, field: "code" },
    });
    const { resolveCodeFill } = setup();
    const fill = await resolveCodeFill({ kind: "fill_code", ref: "e1", secret: "work" }, 0);
    expect(resolved.resolveLoginFill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "work", field: LOGIN_CODE_FIELD, code: true }),
    );
    expect(fill).toMatchObject({ origin: "https://example.test" });
    const held = fill as { claim: () => Promise<unknown>; restore: () => Promise<void> };
    expect(await held.claim()).toBeUndefined();
    await expect(held.restore()).resolves.toBeUndefined();
  });

  it("passes on what the vault refused", async () => {
    resolved.resolveLoginFill.mockResolvedValue({ error: "no" });
    const { resolveSecretFill, resolveCodeFill } = setup();
    expect(
      await resolveSecretFill({ kind: "fill_secret", ref: "e1", secret: "work", field: "x" }, 0),
    ).toEqual({ error: "no" });
    expect(await resolveCodeFill({ kind: "fill_code", ref: "e1", secret: "work" }, 0)).toEqual({
      error: "no",
    });
  });

  it("fills nothing it was not given a handle for", async () => {
    const { resolveSecretFill } = setup();
    for (const answer of [
      { ...linked, deviceLogin: undefined },
      { ...linked, used: undefined },
    ]) {
      resolved.resolveLoginFill.mockResolvedValue(answer);
      expect(
        await resolveSecretFill({ kind: "fill_secret", ref: "e1", secret: "work", field: "x" }, 0),
      ).toEqual({ error: "Saved logins are unavailable here." });
    }
  });

  it("has no code to type that the person gave this run: the server holds those, not the computer", async () => {
    const { resolveCodeFill } = setup();
    expect(await resolveCodeFill({ kind: "fill_code", ref: "e1" }, 0)).toEqual({
      error: "Codes are unavailable here.",
    });
    expect(resolved.resolveLoginFill).not.toHaveBeenCalled();
  });
});
