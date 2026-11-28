import { describe, expect, it, vi } from "vitest";
import { knownSandboxKinds } from "./computer-providers.js";
import { watchesScreenWithoutWake, watchScreen } from "./dozo-screen-watch.js";

const context = { signal: new AbortController().signal } as never;
const computer = (kind: string) => ({ homeKey: "home-1", kind, providerRef: "ref-1" });

describe("watching a screen from the computers wall", () => {
  it("never reaches the provider for a kind whose screen read could wake it, or an unknown kind", async () => {
    const shut = [...knownSandboxKinds.filter((kind) => !watchesScreenWithoutWake(kind)), "unknown"];
    expect(shut.length).toBeGreaterThan(1);
    for (const kind of shut) {
      const connectScreen = vi.fn();
      await expect(watchScreen({ connectScreen }, computer(kind), context)).resolves.toBeNull();
      expect(connectScreen).not.toHaveBeenCalled();
    }
  });

  it("asks a kind that watches without waking for a view-only stream, with no start size or control", async () => {
    const watched = knownSandboxKinds.filter(watchesScreenWithoutWake);
    expect(watched).toContain("docker");
    for (const kind of watched) {
      const connectScreen = vi.fn(async () => ({ url: "http://sandbox.internal/screen" }));
      await watchScreen({ connectScreen } as never, computer(kind), context);
      expect(connectScreen).toHaveBeenCalledExactlyOnceWith(
        { id: "ref-1", botId: "home-1", kind, providerRef: "ref-1" },
        { view: "stream", interactive: false },
        context,
      );
    }
  });

  it("answers no screen for a computer with no machine behind it", async () => {
    const connectScreen = vi.fn();
    await expect(
      watchScreen({ connectScreen }, { ...computer("docker"), providerRef: null }, context),
    ).resolves.toBeNull();
    expect(connectScreen).not.toHaveBeenCalled();
  });
});
