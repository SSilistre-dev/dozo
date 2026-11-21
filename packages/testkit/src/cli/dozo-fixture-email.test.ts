import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  updateMany: vi.fn(async () => ({ count: 1 })),
  disconnect: vi.fn(async () => undefined),
  end: vi.fn(async () => undefined),
  urls: [] as string[],
}));

vi.mock("@rakazo/db", () => ({
  createDb: (url: string) => {
    db.urls.push(url);
    return {
      prisma: { user: { updateMany: db.updateMany }, $disconnect: db.disconnect },
      pool: { end: db.end },
    };
  },
}));

import { dozoVerifyFixtureEmail } from "./dozo-fixture-email.js";

describe("screenshot fixture addresses", () => {
  it("marks the address proven, matched in lower case, and closes the connection", async () => {
    await dozoVerifyFixtureEmail("postgres://fixture", "Shots@Example.test");
    expect(db.urls).toEqual(["postgres://fixture"]);
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { email: "shots@example.test" },
      data: { emailVerified: true },
    });
    expect(db.disconnect).toHaveBeenCalledOnce();
    expect(db.end).toHaveBeenCalledOnce();
  });

  it("closes the connection when the update fails", async () => {
    db.updateMany.mockRejectedValueOnce(new Error("down"));
    await expect(dozoVerifyFixtureEmail("postgres://fixture", "a@example.test")).rejects.toThrow(
      "down",
    );
    expect(db.disconnect).toHaveBeenCalledOnce();
    expect(db.end).toHaveBeenCalledOnce();
  });
});
