import { flush } from "@rakazo/core/test-async";
import { beforeEach, expect, it, vi } from "vitest";

const load = vi.hoisted(() => vi.fn());
vi.mock("./PluginsOverlay", () => load());

beforeEach(() => {
  vi.resetModules();
});

// First: the mocked overlay module is only evaluated until one evaluation succeeds.
it("tries again after a failed fetch, and a warm-up keeps the failure to itself", async () => {
  load
    .mockImplementationOnce(() => {
      throw new Error("chunk gone");
    })
    .mockReturnValue({ PluginsOverlay: "overlay" });
  const { preloadPluginsOverlay, warmPluginsOverlay } = await import(
    "./dozo-plugins-overlay-chunk"
  );
  warmPluginsOverlay();
  await flush();
  await expect(preloadPluginsOverlay()).resolves.toBe("overlay");
  expect(load).toHaveBeenCalledTimes(2);
});

it("fetches the overlay's code once for every caller", async () => {
  const { preloadPluginsOverlay, warmPluginsOverlay } = await import(
    "./dozo-plugins-overlay-chunk"
  );
  warmPluginsOverlay();
  const first = preloadPluginsOverlay();
  expect(preloadPluginsOverlay()).toBe(first);
  await expect(first).resolves.toBe("overlay");
});
