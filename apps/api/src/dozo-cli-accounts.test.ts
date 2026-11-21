import { createRouterClient } from "@orpc/server";
import { ClientError } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoCliAccountsRoutes } from "./dozo-cli-accounts.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const fake = vi.hoisted(() => ({
  read: vi.fn(),
  connection: vi.fn(),
  persist: vi.fn(),
  startLogin: vi.fn(),
  sendCode: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  readCliTools: fake.read,
  cliHomeConnection: fake.connection,
  startCliAccountLogin: fake.startLogin,
  sendCliLoginCode: fake.sendCode,
  cancelCliLogin: fake.cancel,
}));
vi.mock("./model-credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-credentials.js")>()),
  persistModelCredential: fake.persist,
}));

const TOOL = {
  provider: "tool-a",
  name: "Tool A",
  mode: "model" as const,
  found: true,
  signedIn: true,
  connected: false,
  canAdd: true,
};
const CONNECTION = { provider: "tool-a", label: "Tool A", plaintext: "ref", modelId: "m-1" };
const publishRosterChange = vi.fn(async () => undefined);
const prisma = { space: { findUnique: async () => null } };
const secrets = { load: vi.fn() };

function client(userId: string | null) {
  const ctx = createRouterContext({
    prisma,
    secrets,
    events: { notify: () => undefined, publishSpaceChange: () => undefined, publishRosterChange },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(dozoCliAccountsRoutes(ctx), {
    context: {
      actor: userId
        ? {
            userId,
            spaceId: `space-${userId}`,
            email: `${userId}@example.test`,
            isDeploymentOwner: false,
          }
        : null,
    },
  }).dozoCliAccounts;
}

describe("CLI account routes", () => {
  beforeEach(() => {
    fake.read.mockReset().mockResolvedValue([TOOL]);
    fake.connection.mockReset().mockResolvedValue(CONNECTION);
    fake.persist.mockReset().mockResolvedValue({ id: "cred-1" });
    fake.startLogin.mockReset().mockResolvedValue({ status: "waiting" });
    fake.sendCode.mockReset();
    fake.cancel.mockReset().mockResolvedValue(undefined);
    publishRosterChange.mockClear();
  });

  it("lists the caller's tools", async () => {
    expect(await client("ada").list()).toEqual({ tools: [TOOL] });
    expect(fake.read).toHaveBeenCalledWith({ prisma, secretStore: secrets }, "ada");
  });

  it("saves the connection as the caller's own, and signals only the caller's apps", async () => {
    fake.read.mockResolvedValueOnce([{ ...TOOL, connected: true }]);
    expect(await client("ada").connect({ provider: "tool-a" })).toEqual({
      tools: [{ ...TOOL, connected: true }],
    });
    expect(fake.connection).toHaveBeenCalledWith(
      { prisma, secretStore: secrets },
      "ada",
      "tool-a",
      {
        consent: false,
        termsConsent: false,
      },
    );
    const [, actor, input] = fake.persist.mock.calls[0]!;
    expect(actor).toMatchObject({ userId: "ada" });
    // It becomes the main model only while there is none.
    expect(input).toMatchObject({ ...CONNECTION, keepExistingDefault: true });
    expect(publishRosterChange).toHaveBeenCalledWith({ userIds: ["ada"] });
  });

  it("passes the person's agreement on for an agent", async () => {
    await client("ada").connect({ provider: "tool-a", consent: true, termsConsent: true });
    expect(fake.connection).toHaveBeenCalledWith(expect.anything(), "ada", "tool-a", {
      consent: true,
      termsConsent: true,
    });
  });

  it("passes a refusal on and saves nothing", async () => {
    fake.connection.mockRejectedValue(new ClientError("CONFLICT", "Sign in first."));
    await expect(client("ada").connect({ provider: "tool-a" })).rejects.toThrow("Sign in first.");
    expect(fake.persist).not.toHaveBeenCalled();
    expect(publishRosterChange).not.toHaveBeenCalled();
  });

  it("starts another account's sign-in, and saves it as the caller's own once the tool says so", async () => {
    expect(await client("ada").addAccount({ provider: "tool-a" })).toEqual({ tools: [TOOL] });
    const [, userId, provider, handlers] = fake.startLogin.mock.calls[0]!;
    expect([userId, provider]).toEqual(["ada", "tool-a"]);
    // The sign-in ends after the request; its steps signal the caller's apps.
    handlers.changed();
    expect(publishRosterChange).toHaveBeenCalledWith({ userIds: ["ada"] });
    await handlers.save(CONNECTION);
    const [, actor, input] = fake.persist.mock.calls[0]!;
    expect(actor).toMatchObject({ userId: "ada" });
    expect(input).toEqual({ ...CONNECTION, credentialId: null, keepExistingDefault: true });
  });

  it("hands a code to the caller's own sign-in", async () => {
    await client("ada").sendCode({ provider: "tool-a", code: "abc#123" });
    expect(fake.sendCode).toHaveBeenCalledWith("ada", "tool-a", "abc#123");
  });

  it("cancels the caller's own sign-in and signals their apps", async () => {
    await client("ada").cancelLogin({ provider: "tool-a" });
    expect(fake.cancel).toHaveBeenCalledWith("ada", "tool-a");
    expect(publishRosterChange).toHaveBeenCalledWith({ userIds: ["ada"] });
  });

  it("refuses a caller who is not signed in", async () => {
    await expect(client(null).list()).rejects.toThrow();
    expect(fake.read).not.toHaveBeenCalled();
  });
});
