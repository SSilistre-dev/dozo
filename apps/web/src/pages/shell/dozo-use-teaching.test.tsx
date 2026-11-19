// @vitest-environment jsdom

import { deferred, flush } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueTeachComputerInput } from "../../components/teach/teach-computer-input-chain";
import { useTeaching } from "./dozo-use-teaching";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

function setup(botId: string) {
  const stop = vi.fn(async () => ({}));
  const closeComputer = vi.fn();
  const options = {
    rpc: { skills: { stop } },
    queries: {},
    thread: {
      taughtSkills: [{ id: "skill-1", status: "recording" }],
      taughtSkillsBotId: botId,
    },
    activeBotId: { current: botId },
    refreshThreadRef: { current: async () => undefined },
    closeComputer,
  } as unknown as Parameters<typeof useTeaching>[0];
  const current: { value?: ReturnType<typeof useTeaching> } = {};
  function Probe() {
    current.value = useTeaching(options);
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root?.render(<Probe />));
  const hook = () => current.value as ReturnType<typeof useTeaching>;
  return { hook, stop, closeComputer };
}

describe("useTeaching", () => {
  it("stops only after the bot's queued input reached the computer", async () => {
    const botId = "bot-queued";
    const typed: string[] = [];
    const gate = deferred();
    void enqueueTeachComputerInput(botId, async () => {
      await gate.promise;
      typed.push("8");
    });
    void enqueueTeachComputerInput(botId, async () => {
      typed.push("Enter");
    });
    const { hook, stop, closeComputer } = setup(botId);

    let stopped!: Promise<void>;
    act(() => {
      stopped = hook().stopTeaching();
    });
    await act(() => flush());
    expect(stop).not.toHaveBeenCalled();
    expect(hook().teachBusy).toBe(true);
    // A second press while waiting sends no second stop.
    await act(() => hook().stopTeaching());

    await act(async () => {
      gate.resolve();
      await stopped;
    });
    expect(typed).toEqual(["8", "Enter"]);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith({ skillId: "skill-1" });
    expect(closeComputer).toHaveBeenCalledOnce();
    expect(hook().teachBusy).toBe(false);
  });

  it("still stops after queued input failed", async () => {
    const botId = "bot-failed";
    await expect(
      enqueueTeachComputerInput(botId, async () => {
        throw new Error("gone");
      }),
    ).rejects.toThrow("gone");
    const { hook, stop } = setup(botId);
    await act(() => hook().stopTeaching());
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does nothing without an open bot", async () => {
    const { hook, stop } = setup("");
    await act(() => hook().stopTeaching());
    expect(stop).not.toHaveBeenCalled();
  });
});
