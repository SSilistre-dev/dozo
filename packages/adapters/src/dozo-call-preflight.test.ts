import http from "node:http";
import type { AddressInfo } from "node:net";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { flush } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALL_CHECK_MS,
  dozoBotModelEndpoint,
  dozoProviderAddress,
  dozoUnansweredEndpoints,
  dozoVoiceServerEndpoints,
} from "./dozo-call-preflight.js";
import type { ModelCredential } from "./model-selection.js";
import { serializeOpenAiCompatibleVoiceSecret } from "./openai-compatible-voice.js";

const mocks = vi.hoisted(() => ({
  main: vi.fn(),
  connected: vi.fn(),
  secret: vi.fn(),
}));

vi.mock("./model-roles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-roles.js")>()),
  resolveMemberMainModel: mocks.main,
}));
vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-selection.js")>()),
  findConnectedModelCredential: mocks.connected,
  loadStoredModelSecret: mocks.secret,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.main.mockReset();
  mocks.connected.mockReset();
  mocks.secret.mockReset();
});

describe("a self-hosted speech server's addresses", () => {
  it("are the speech address, and the transcription address when it has its own", () => {
    const shared = serializeOpenAiCompatibleVoiceSecret(
      { baseUrl: "http://127.0.0.1:8880" },
      undefined,
      {
        allowPrivate: true,
      },
    );
    expect(dozoVoiceServerEndpoints(shared)).toEqual({
      speech: "http://127.0.0.1:8880/v1",
      transcription: "http://127.0.0.1:8880/v1",
    });
    const split = serializeOpenAiCompatibleVoiceSecret(
      { baseUrl: "http://127.0.0.1:8880", sttBaseUrl: "http://127.0.0.1:8881" },
      undefined,
      { allowPrivate: true },
    );
    expect(dozoVoiceServerEndpoints(split)).toEqual({
      speech: "http://127.0.0.1:8880/v1",
      transcription: "http://127.0.0.1:8881/v1",
    });
  });

  it("are none for a hosted provider's key or a secret that cannot be read", () => {
    expect(dozoVoiceServerEndpoints("sk-a-hosted-providers-key")).toBeUndefined();
    expect(dozoVoiceServerEndpoints('{"kind":"openai_compatible"}')).toBeUndefined();
  });
});

const scope = { userId: "ada", spaceId: "space-ada" };
const credential = {
  id: "c1",
  userId: "ada",
  provider: "openai-compatible",
  label: "Local",
  secretId: "s1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  defaultModel: null,
  thinkingLevel: null,
};

function botModel(options: {
  override?: { modelProvider: string; modelId: string } | null;
  main?: { provider: string; modelId: string; credential: ModelCredential } | null;
  plaintext?: string;
  status?: "loaded" | "missing";
}) {
  const findFirst = vi.fn(async () => options.override ?? null);
  mocks.main.mockResolvedValue(options.main ?? null);
  mocks.connected.mockResolvedValue(options.override ? credential : null);
  mocks.secret.mockResolvedValue(
    options.status === "missing"
      ? { status: "missing" }
      : { status: "loaded", ciphertext: "x", plaintext: options.plaintext ?? "" },
  );
  const deps = { prisma: { bot: { findFirst } }, secretStore: { load: vi.fn() } };
  return dozoBotModelEndpoint(deps as never, scope, "bot-1");
}

const compatible = (baseUrl: string) => JSON.stringify({ kind: "openai_compatible", baseUrl });

describe("the address a bot's model runs at", () => {
  it("is its own connection's, when the bot has a model of its own", async () => {
    const address = await botModel({
      override: { modelProvider: "openai-compatible", modelId: "qwen3:4b" },
      plaintext: compatible("http://127.0.0.1:11434"),
    });
    expect(address).toBe("http://127.0.0.1:11434/v1");
    expect(mocks.connected).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      scope,
      "openai-compatible",
      "qwen3:4b",
    );
  });

  it("is the main model's connection when the bot follows it", async () => {
    const address = await botModel({
      main: { provider: "openai-compatible", modelId: "llama", credential },
      plaintext: compatible("http://127.0.0.1:1234/v1"),
    });
    expect(address).toBe("http://127.0.0.1:1234/v1");
  });

  it("is none with no connection behind the model", async () => {
    expect(await botModel({})).toBeUndefined();
    expect(mocks.secret).not.toHaveBeenCalled();
  });

  it("is none for a hosted provider's key, a missing secret or one that does not parse", async () => {
    const main = { provider: "p", modelId: "m", credential };
    expect(
      await botModel({ main, plaintext: JSON.stringify({ kind: "api_key", key: "sk-1" }) }),
    ).toBeUndefined();
    expect(await botModel({ main, status: "missing" })).toBeUndefined();
    expect(
      await botModel({ main, plaintext: JSON.stringify({ kind: "openai_compatible" }) }),
    ).toBeUndefined();
  });
});

const providers = builtinModels().getProviders();
const withAddress = providers.find((entry) => dozoProviderAddress(entry.id));
const withoutAddress = providers.find((entry) => !dozoProviderAddress(entry.id));

describe("the address the model registry gives a provider", () => {
  it("is one https address without placeholders or credentials, for the providers that have one", () => {
    const addresses = providers.flatMap((entry) => dozoProviderAddress(entry.id) ?? []);
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) {
      const url = new URL(address);
      expect(url.protocol).toBe("https:");
      expect(address).not.toMatch(/[{}]|\/$/);
      expect(url.username).toBe("");
    }
  });

  it("is none for a provider that has no single address, and for an unknown one", () => {
    expect(withoutAddress).toBeDefined();
    expect(dozoProviderAddress("no-such-provider")).toBeUndefined();
  });
});

describe("the address of a hosted provider's model", () => {
  const hosted = JSON.stringify({ kind: "api_key", key: "sk-test-1" });

  it("is the registry's, without the key being read or sent", async () => {
    const provider = withAddress?.id ?? "";
    const address = await botModel({
      main: { provider, modelId: "m", credential: { ...credential, provider } },
      plaintext: hosted,
    });
    expect(address).toBe(dozoProviderAddress(provider));
    expect(address).toMatch(/^https:/);
  });

  it("is none when the registry gives the provider no address", async () => {
    const provider = withoutAddress?.id ?? "";
    expect(
      await botModel({
        main: { provider, modelId: "m", credential: { ...credential, provider } },
        plaintext: hosted,
      }),
    ).toBeUndefined();
  });
});

describe("which providers are asked at all", () => {
  /** Why the registry gives a provider no address, by the shape of what it does give. */
  function classOf(entry: (typeof providers)[number]) {
    const urls = new Set(
      entry.getModels().flatMap((model) => (model.baseUrl ? [model.baseUrl] : [])),
    );
    if (dozoProviderAddress(entry.id)) return "asked";
    if (urls.size === 0) return "no address in the registry";
    if (urls.size > 1) return "several addresses";
    return [...urls][0]?.includes("{") ? "placeholder in the address" : "not https";
  }

  it("is pinned to the model registry: a changed count means a class of providers moved", () => {
    const counts: Record<string, number> = {};
    for (const entry of providers) counts[classOf(entry)] = (counts[classOf(entry)] ?? 0) + 1;
    expect(counts).toEqual({
      asked: 32,
      "several addresses": 6,
      "no address in the registry": 2,
      "placeholder in the address": 2,
    });
  });

  it("leaves every provider without an address to pass: nothing is asked and nothing refuses", async () => {
    const fetch = vi.fn();
    for (const entry of providers.filter((candidate) => classOf(candidate) !== "asked")) {
      const address = await botModel({
        main: {
          provider: entry.id,
          modelId: "m",
          credential: { ...credential, provider: entry.id },
        },
        plaintext: JSON.stringify({ kind: "api_key", key: "sk-test-1" }),
      });
      expect(address).toBeUndefined();
      expect(await dozoUnansweredEndpoints({ model: address }, fetch)).toEqual([]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a bot with no connected model, or a deployment-managed one, to pass", async () => {
    expect(await botModel({})).toBeUndefined();
  });
});

/** A fake network: each address answers with its status, or refuses the connection. */
function network(answers: Record<string, number | "refused" | "silent">) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const answer = answers[url.port];
    if (answer === "refused" || answer === undefined) {
      throw new TypeError("fetch failed: connection refused");
    }
    if (answer === "silent") {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return new Response("{}", { status: answer === "silent" ? 200 : answer });
  });
}

const addresses = {
  speech: "http://127.0.0.1:8001/v1",
  transcription: "http://127.0.0.1:8002/v1",
  model: "http://127.0.0.1:8003/v1",
};

describe("asking the addresses a call needs", () => {
  it("finds every one answering", async () => {
    const fetch = network({ "8001": 200, "8002": 200, "8003": 200 });
    expect(await dozoUnansweredEndpoints(addresses, fetch)).toEqual([]);
    expect(fetch.mock.calls.map(([input]) => String(input)).sort()).toEqual([
      "http://127.0.0.1:8001/v1/models",
      "http://127.0.0.1:8002/v1/models",
      "http://127.0.0.1:8003/v1/models",
    ]);
  });

  it("counts any status as answering and a refused connection as not", async () => {
    const fetch = network({ "8001": 404, "8002": "refused", "8003": 401 });
    expect(await dozoUnansweredEndpoints(addresses, fetch)).toEqual(["transcription"]);
  });

  it("asks only the addresses it was given, and sends no key", async () => {
    const fetch = network({ "8003": 200 });
    expect(await dozoUnansweredEndpoints({ model: addresses.model }, fetch)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1];
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization/i);
  });

  it("gives up on a silent address after CALL_CHECK_MS, all asked together", async () => {
    vi.useFakeTimers();
    // Node's own timeout signal ignores the fake clock: tie it to it.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const fetch = network({ "8001": 200, "8002": "silent", "8003": "silent" });
    const asking = dozoUnansweredEndpoints(addresses, fetch);
    await vi.advanceTimersByTimeAsync(CALL_CHECK_MS - 1);
    let settled = false;
    void asking.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await asking).toEqual(["transcription", "model"]);
    expect(CALL_CHECK_MS).toBe(2_000);
  });

  it("stops when the caller goes away", async () => {
    const caller = new AbortController();
    const fetch = network({ "8001": "silent" });
    const asking = dozoUnansweredEndpoints({ speech: addresses.speech }, fetch, caller.signal);
    await flush();
    caller.abort(new Error("gone"));
    await expect(asking).rejects.toThrow("gone");
  });

  it("finds a hosted address silent when there is no network, after CALL_CHECK_MS", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const asking = dozoUnansweredEndpoints({ model: "https://models.example.test/v1" }, fetch);
    await vi.advanceTimersByTimeAsync(CALL_CHECK_MS);
    expect(await asking).toEqual(["model"]);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://models.example.test/v1/models");
  });

  it("does not ask a public address where public hosts are off, and counts it as answering", async () => {
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "0");
    const fetch = network({ "8003": 200 });
    const unanswered = await dozoUnansweredEndpoints(
      { model: "https://models.example.test/v1", speech: "http://127.0.0.1:8001/v1" },
      fetch,
    );
    // The private address is still asked (and refused here); the public one never is.
    expect(unanswered).toEqual(["speech"]);
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).host)).toEqual([
      "127.0.0.1:8001",
    ]);
    vi.unstubAllEnvs();
  });

  it("counts a redirect as answering, without following it", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    });
    expect(await dozoUnansweredEndpoints({ model: addresses.model }, fetch)).toEqual([]);
  });

  it("tells a real server's redirect from a refused connection", async () => {
    const server = http.createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", "http://127.0.0.1:1/elsewhere");
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await dozoUnansweredEndpoints({ model: `http://127.0.0.1:${port}/v1` })).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    // Nothing listens there any more: the same address now refuses the connection.
    expect(await dozoUnansweredEndpoints({ model: `http://127.0.0.1:${port}/v1` })).toEqual([
      "model",
    ]);
  });
});
