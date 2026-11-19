import { describe, expect, it, vi } from "vitest";
import { teachClickTarget } from "./dozo-teach-targets.js";

// A picture that never finishes decoding.
vi.mock("sharp", () => ({
  default: () => ({ metadata: () => new Promise(() => undefined) }),
}));

describe("teachClickTarget", () => {
  it("does not wait for a picture past the capture's time, and keeps the window", async () => {
    const target = await teachClickTarget({
      x: 5,
      y: 5,
      budgetMs: 20,
      observation: {
        frameId: "f1",
        capturedAt: "2026-11-19T12:00:00.000Z",
        mimeType: "image/png",
        image: new Uint8Array([1]),
        width: 100,
        height: 100,
        activeWindow: { id: "w", title: "Form" },
      },
    });
    expect(target).toEqual({ window: "Form" });
  });
});
