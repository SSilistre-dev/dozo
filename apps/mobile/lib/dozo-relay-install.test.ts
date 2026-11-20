import { i18n as lingui } from "@lingui/core";
import { expect, it, vi } from "vitest";
import { relayOrigin } from "./dozo-relay-connection";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-crypto", () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }));

it("puts the relay in front of the global fetch and passes the layout's first import on", async () => {
  const direct = vi.fn(async () => new Response("direct"));
  vi.stubGlobal("fetch", direct);
  const { i18n } = await import("./dozo-relay-install");
  expect(i18n).toBe(lingui);
  expect(globalThis.fetch).not.toBe(direct);
  expect(await (await fetch("https://app.example.invalid/")).text()).toBe("direct");
  await expect(fetch(`${relayOrigin("q83vEjRWeJCrze8SNFZ4kA")}/`)).rejects.toThrow(
    "Network request failed",
  );
  vi.unstubAllGlobals();
});
