import { describe, expect, it } from "vitest";
import { DozoModelPoolSchema, dozoModelPoolContract } from "./dozo-model-pool.js";
import { appContract } from "./rpc.js";

const setInput = dozoModelPoolContract.set["~orpc"].inputSchema!;

describe("model pool contract", () => {
  it("joins the app contract", () => {
    expect(appContract.dozoModelPool).toBe(dozoModelPoolContract);
  });

  it("reads a connection's opening time only as a date", () => {
    const opensAt = "2026-11-20T14:30:00.000Z";
    const pool = { connections: [{ credentialId: "a", pooled: true, opensAt }] };
    expect(DozoModelPoolSchema.parse(pool)).toEqual(pool);
    expect(
      DozoModelPoolSchema.safeParse({
        connections: [{ credentialId: "a", pooled: true, opensAt: "soon" }],
      }).success,
    ).toBe(false);
  });

  it("switches by naming a connection, on or off", async () => {
    expect(await setInput["~standard"].validate({ credentialId: "a", pooled: false })).toEqual({
      value: { credentialId: "a", pooled: false },
    });
    expect(await setInput["~standard"].validate({ credentialId: "", pooled: true })).toHaveProperty(
      "issues",
    );
  });
});
