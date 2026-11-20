import { RELAY_SESSION_PATH } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { askComputerForSignIn } from "./dozo-relay-sign-in";

const state = vi.hoisted(() => ({
  base: "https://ab.computer.dozo.invalid",
  generation: 1,
  switching: false,
  cleared: true,
}));
const calls = vi.hoisted(() => ({
  save: vi.fn(async () => {
    state.generation += 1;
  }),
  pending: vi.fn(async () => true),
  deliver: vi.fn(async () => undefined),
}));

vi.mock("./api", () => ({
  currentApiBase: () => state.base,
  endpointChangeInProgress: () => state.switching,
  savePendingSignOut: calls.pending,
  deliverSignOutRecord: calls.deliver,
}));
vi.mock("./api-server", () => ({ clearSpace: async () => state.cleared }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  saveSessionToken: calls.save,
}));

const answer = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    ),
  );

beforeEach(() => {
  vi.unstubAllGlobals();
  Object.assign(state, { generation: 1, switching: false, cleared: true });
  for (const call of Object.values(calls)) call.mockClear();
});

it("saves the session the computer gives, asked at the computer's sign-in address", async () => {
  answer(200, { token: "session.signature" });
  expect(await askComputerForSignIn()).toBe("signed-in");
  expect(fetch).toHaveBeenCalledWith(
    `${state.base}${RELAY_SESSION_PATH}`,
    expect.objectContaining({ method: "POST" }),
  );
  expect(calls.save).toHaveBeenCalledWith("session.signature");
});

it("passes on why the computer gave none", async () => {
  for (const reason of ["sign-in-on-computer", "one-account", "used"]) {
    answer(reason === "used" ? 410 : 409, { reason });
    expect(await askComputerForSignIn()).toBe(reason);
  }
  answer(404, "");
  expect(await askComputerForSignIn()).toBe("unreachable");
  answer(200, { nope: true });
  expect(await askComputerForSignIn()).toBe("unreachable");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Network request failed");
    }),
  );
  expect(await askComputerForSignIn()).toBe("unreachable");
  expect(calls.save).not.toHaveBeenCalled();
});

it("passes on a failure that is not the network's", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("bug");
    }),
  );
  await expect(askComputerForSignIn()).rejects.toThrow("bug");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => Promise.reject(new Error("bad")) })),
  );
  await expect(askComputerForSignIn()).rejects.toThrow("bad");
});

it("never keeps a session for a server the app left meanwhile, and ends it there", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      state.base = "https://other.example.invalid";
      return new Response(JSON.stringify({ token: "session.signature" }));
    }),
  );
  expect(await askComputerForSignIn()).toBe("unreachable");
  expect(calls.save).not.toHaveBeenCalled();
  expect(calls.pending).toHaveBeenCalledWith(
    expect.objectContaining({
      apiBase: "https://ab.computer.dozo.invalid",
      token: "session.signature",
    }),
  );
  state.base = "https://ab.computer.dozo.invalid";

  state.cleared = false;
  answer(200, { token: "t.s" });
  expect(await askComputerForSignIn()).toBe("unreachable");

  state.cleared = true;
  calls.save.mockImplementationOnce(async () => {
    state.generation += 2;
  });
  answer(200, { token: "t.s" });
  expect(await askComputerForSignIn()).toBe("unreachable");
});
