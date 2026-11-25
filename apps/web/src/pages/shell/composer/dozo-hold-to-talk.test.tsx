// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DictationSnapshot } from "../../lib/dictation";
import { dictation } from "../../lib/dictation";
import { TALK_KEY_EVENT, useHoldToTalk } from "./dozo-hold-to-talk";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return { useLingui: () => ({ t }) };
});

const watchers = new Set<(snapshot: DictationSnapshot) => void>();
let onFinal: ((text: string) => void) | null = null;

function emit(snapshot: DictationSnapshot) {
  for (const watcher of [...watchers]) watcher(snapshot);
}

let webSpeech = false;

vi.mock("../../lib/dictation", () => ({
  webSpeechAvailable: () => webSpeech,
  dictation: {
    subscribe: vi.fn((watcher: (snapshot: DictationSnapshot) => void) => {
      watchers.add(watcher);
      watcher({ status: "idle", transcript: "" });
      return () => watchers.delete(watcher);
    }),
    listen: vi.fn(async (opts: { onFinal: (text: string) => void }) => {
      onFinal = opts.onFinal;
      emit({ status: "listening", transcript: "" });
    }),
    submitHold: vi.fn(() => {
      const final = onFinal;
      onFinal = null;
      emit({ status: "idle", transcript: "" });
      final?.("hello");
    }),
    stop: vi.fn(() => {
      onFinal = null;
      emit({ status: "idle", transcript: "" });
    }),
    state: { status: "idle", transcript: "" },
  },
}));

function Composer({
  name,
  disabled,
  transcribe = true,
}: {
  name: string;
  disabled?: boolean;
  transcribe?: boolean;
}) {
  useHoldToTalk({ transcribe, disabled, onText: (text) => said.push(`${name}: ${text}`) });
  return null;
}

let said: string[] = [];
let root: Root;

function key(detail: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(TALK_KEY_EVENT, { detail }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  said = [];
  webSpeech = false;
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("starts the composer's dictation on key down and sends it on key up", () => {
  act(() => root.render(<Composer name="chat" />));
  key("down");
  expect(dictation.listen).toHaveBeenCalledTimes(1);
  expect(dictation.listen).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "hold", transcribe: true }),
  );
  // Key repeat while held starts nothing more.
  key("down");
  expect(dictation.listen).toHaveBeenCalledTimes(1);
  key("up");
  expect(dictation.submitHold).toHaveBeenCalledTimes(1);
  expect(said).toEqual(["chat: hello"]);
});

it("never opens the microphone where the button is disabled or absent", () => {
  act(() => root.render(<Composer name="chat" disabled />));
  key("down");
  key("up");
  act(() => root.render(<div />));
  key("down");
  expect(dictation.listen).not.toHaveBeenCalled();
  expect(dictation.submitHold).not.toHaveBeenCalled();
});

it("opens no microphone when nothing can turn speech into text", () => {
  act(() => root.render(<Composer name="chat" transcribe={false} />));
  key("down");
  key("up");
  expect(dictation.listen).not.toHaveBeenCalled();
  // The web view's own recognizer is enough.
  webSpeech = true;
  key("down");
  expect(dictation.listen).toHaveBeenCalledTimes(1);
});

it("ignores anything but down and up, and an up the key did not start", () => {
  act(() => root.render(<Composer name="chat" />));
  for (const detail of ["up", "start", 1, null, { phase: "down" }]) key(detail);
  expect(dictation.listen).not.toHaveBeenCalled();
  expect(dictation.submitHold).not.toHaveBeenCalled();
});

it("drives only the newest composer on screen", () => {
  act(() =>
    root.render(
      <>
        <Composer name="chat" />
        <Composer name="thread" />
      </>,
    ),
  );
  key("down");
  key("up");
  expect(dictation.listen).toHaveBeenCalledTimes(1);
  expect(said).toEqual(["thread: hello"]);
  act(() => root.render(<Composer name="chat" />));
  key("down");
  key("up");
  expect(said).toEqual(["thread: hello", "chat: hello"]);
});
