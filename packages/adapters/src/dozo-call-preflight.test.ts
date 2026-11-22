import { flush } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALL_CHECK_MS,
  dozoBotModelEndpoint,
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
});
