import { createRouterClient } from "@orpc/server";
import { serializeOpenAiCompatibleVoiceSecret } from "@rakazo/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dozoCallPreflightRoutes } from "./dozo-call-preflight.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const mocks = vi.hoisted(() => ({ model: vi.fn(), voice: vi.fn() }));

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  dozoBotModelEndpoint: mocks.model,
}));
vi.mock("./voice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./voice.js")>()),
  loadDefaultVoiceCredential: mocks.voice,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.model.mockReset();
  mocks.voice.mockReset();
});

/** A fake network: each port answers with its status, refuses, or never answers. */
function network(answers: Record<string, number | "refused" | "silent">) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const answer = answers[url.port] ?? "refused";
    if (answer === "refused") throw new TypeError("fetch failed: connection refused");
    if (answer === "silent") {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return new Response("{}", { status: answer === "silent" ? 200 : answer });
  });
}

function client(allowPrivate: boolean, fetch: typeof globalThis.fetch) {
  const ctx = createRouterContext({
    prisma: { space: { findUnique: async () => null } },
    events: { notify: () => undefined, publishSpaceChange: () => undefined },
    env: { mcpAllowPrivateEndpoint: allowPrivate },
    modelConnectionFetch: fetch,
  } as unknown as RouterDeps);
  return createRouterClient(dozoCallPreflightRoutes(ctx), {
    context: {
      actor: {
        userId: "ada",
        spaceId: "space-ada",
        email: "ada@example.test",
        isDeploymentOwner: false,
      },
    },
  }).dozoCallPreflight;
}

/** The speech server's secret: speech on 8001, transcription on 8002. */
function ownSpeechServer(provider = "openai-compatible") {
  mocks.voice.mockResolvedValue({
    cred: { provider },
    linked: false,
    apiKey: serializeOpenAiCompatibleVoiceSecret(
      { baseUrl: "http://127.0.0.1:8001", sttBaseUrl: "http://127.0.0.1:8002" },
      undefined,
      { allowPrivate: true },
    ),
  });
}

const check = (fetch: typeof globalThis.fetch, allowPrivate = true) =>
  client(allowPrivate, fetch).check({ botId: "bot-1" });

describe("the check before a call", () => {
  it("asks nothing where private addresses are not allowed", async () => {
    const fetch = network({ "8001": 200 });
    expect(await check(fetch, false)).toEqual({
      checked: false,
      refusal: null,
      serverDictation: false,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.voice).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("lets the call start when every address answers, and says the server hears the caller", async () => {
    ownSpeechServer();
    mocks.model.mockResolvedValue("http://127.0.0.1:8003/v1");
    const fetch = network({ "8001": 200, "8002": 404, "8003": 200 });
    expect(await check(fetch)).toEqual({ checked: true, refusal: null, serverDictation: true });
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).port).sort()).toEqual([
      "8001",
      "8002",
      "8003",
    ]);
  });

  it("refuses for the speech address that does not answer", async () => {
    ownSpeechServer();
    mocks.model.mockResolvedValue("http://127.0.0.1:8003/v1");
    const result = await check(network({ "8002": 200, "8003": 200 }));
    expect(result).toEqual({ checked: true, refusal: "speech", serverDictation: true });
  });

  it("refuses for the transcription address that does not answer", async () => {
    ownSpeechServer();
    mocks.model.mockResolvedValue("http://127.0.0.1:8003/v1");
    const result = await check(network({ "8001": 200, "8003": 200 }));
    expect(result.refusal).toBe("speech");
  });

  it("refuses for the model that does not answer", async () => {
    ownSpeechServer();
    mocks.model.mockResolvedValue("http://127.0.0.1:8003/v1");
    const result = await check(network({ "8001": 200, "8002": 200 }));
    expect(result).toEqual({ checked: true, refusal: "model", serverDictation: true });
  });

  it("names the speech server first when both fail", async () => {
    ownSpeechServer();
    mocks.model.mockResolvedValue("http://127.0.0.1:8003/v1");
    expect((await check(network({}))).refusal).toBe("speech");
  });

  it("asks no speech address for a provider without one, and says nothing hears the caller", async () => {
    mocks.voice.mockResolvedValue({ cred: { provider: "macos" }, linked: false, apiKey: "macos" });
    mocks.model.mockResolvedValue("http://127.0.0.1:8003/v1");
    const fetch = network({ "8003": 200 });
    expect(await check(fetch)).toEqual({ checked: true, refusal: null, serverDictation: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks no address of a hosted speech provider or a hosted model", async () => {
    mocks.voice.mockResolvedValue({
      cred: { provider: "elevenlabs" },
      linked: false,
      apiKey: "a-hosted-providers-key",
    });
    mocks.model.mockResolvedValue(undefined);
    const fetch = network({});
    expect(await check(fetch)).toEqual({ checked: true, refusal: null, serverDictation: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the model alone while no voice is connected", async () => {
    mocks.voice.mockResolvedValue(null);
    mocks.model.mockResolvedValue("http://127.0.0.1:8003/v1");
    expect(await check(network({ "8003": 200 }))).toEqual({
      checked: true,
      refusal: null,
      serverDictation: false,
    });
  });

  it("answers within two seconds when the addresses stay silent", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    ownSpeechServer();
    mocks.model.mockResolvedValue("http://127.0.0.1:8003/v1");
    const asking = check(network({ "8001": "silent", "8002": "silent", "8003": "silent" }));
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false;
    void asking.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await asking).toEqual({ checked: true, refusal: "speech", serverDictation: true });
  });
});
