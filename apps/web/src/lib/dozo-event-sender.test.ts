import { beforeEach, expect, it, vi } from "vitest";
import { forgetEventServer, sendEvent } from "./dozo-event-sender";

const event = { name: "upgrade_viewed", source: "app" } as const;

function client(productEvents: boolean | undefined) {
  return {
    me: vi.fn(async () => ({ productEvents })),
    dozoEvents: { track: vi.fn(async () => ({ ok: true })) },
  };
}

beforeEach(() => forgetEventServer());

it("asks the server once, and sends only to one that takes events", async () => {
  const on = client(true);
  sendEvent(on, event);
  sendEvent(on, event);
  await vi.waitFor(() => expect(on.dozoEvents.track).toHaveBeenCalledTimes(2));
  expect(on.me).toHaveBeenCalledTimes(1);

  forgetEventServer();
  for (const answer of [false, undefined]) {
    forgetEventServer();
    const off = client(answer);
    sendEvent(off, event);
    await vi.waitFor(() => expect(off.me).toHaveBeenCalled());
    await off.me.mock.results[0]!.value;
    expect(off.dozoEvents.track).not.toHaveBeenCalled();
  }
});

it("asks again after the server could not say, and loses a failed report quietly", async () => {
  const flaky = client(true);
  flaky.me.mockRejectedValueOnce(new Error("signed out"));
  sendEvent(flaky, event);
  await vi.waitFor(() => expect(flaky.me).toHaveBeenCalledTimes(1));
  sendEvent(flaky, event);
  await vi.waitFor(() => expect(flaky.dozoEvents.track).toHaveBeenCalledTimes(1));
  expect(flaky.me).toHaveBeenCalledTimes(2);

  flaky.dozoEvents.track.mockRejectedValueOnce(new Error("offline"));
  sendEvent(flaky, event);
  await vi.waitFor(() => expect(flaky.dozoEvents.track).toHaveBeenCalledTimes(2));
});
