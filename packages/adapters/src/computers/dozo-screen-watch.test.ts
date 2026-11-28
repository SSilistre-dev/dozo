import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerSandboxProvider } from "../providers/computer/docker/docker-sandbox.js";
import { knownSandboxKinds } from "./computer-providers.js";
import { watchesScreenWithoutWake, watchScreen } from "./dozo-screen-watch.js";

const context = { signal: new AbortController().signal } as never;
const computer = (kind: string) => ({ homeKey: "home-1", kind, providerRef: "ref-1" });

describe("watching a screen from the computers wall", () => {
  it("never reaches the provider for a kind whose screen read could wake it, or an unknown kind", async () => {
    const shut = [
      ...knownSandboxKinds.filter((kind) => !watchesScreenWithoutWake(kind)),
      "unknown",
    ];
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

describe("watching a docker computer", () => {
  afterEach(() => vi.unstubAllGlobals());

  function supervisor(screenMode: () => Response, running: boolean) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/screen-mode")) return screenMode();
        if (method === "GET" && url.endsWith("/computers/ref-1")) {
          return Response.json({ id: "ref-1", running });
        }
        throw new Error(`unexpected request ${method} ${url}`);
      }),
    );
    return calls;
  }

  it("only asks for the viewer, leaving a controller's control in place", async () => {
    const calls = supervisor(() => Response.json({ screenUrl: "http://supervisor.test/v" }), true);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await expect(watchScreen(provider, computer("docker"), context)).resolves.toMatchObject({
      url: "http://supervisor.test/v",
    });
    expect(calls).toEqual([
      {
        method: "POST",
        url: "http://supervisor.test/computers/ref-1/screen-mode",
        body: { interactive: false, revokeControl: false },
      },
    ]);
  });

  it("fails on a stopped container without starting it", async () => {
    const calls = supervisor(
      () => Response.json({ error: "container computer is not running" }, { status: 400 }),
      false,
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await expect(watchScreen(provider, computer("docker"), context)).rejects.toThrow();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://supervisor.test/computers/ref-1/screen-mode",
      "GET http://supervisor.test/computers/ref-1",
    ]);
  });
});
