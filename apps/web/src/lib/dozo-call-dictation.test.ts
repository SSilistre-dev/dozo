import { afterEach, describe, expect, it, vi } from "vitest";
import { Dictation } from "./calls/dictation.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A desktop browser that has Web Speech, which sends the voice to a cloud recognizer. */
function desktopBrowserWithWebSpeech() {
  const made = vi.fn();
  class FakeRecognition {
    constructor() {
      made();
    }
    start() {}
    stop() {}
    abort() {}
  }
  const track = { stop: vi.fn() };
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130",
    maxTouchPoints: 0,
    language: "en-US",
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
  vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition });
  vi.stubGlobal(
    "MediaRecorder",
    class {
      state = "inactive";
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
      }
    },
  );
  return made;
}

describe("dictation through the speech server", () => {
  it("never starts Web Speech for a call the speech server hears", async () => {
    const made = desktopBrowserWithWebSpeech();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      serverDictation: true,
      onFinal: () => undefined,
    });
    expect(made).not.toHaveBeenCalled();
    dictation.stop("cancel");
  });

  it("still starts Web Speech when the check did not say so", async () => {
    const made = desktopBrowserWithWebSpeech();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", transcribe: true, onFinal: () => undefined });
    expect(made).toHaveBeenCalledTimes(1);
    dictation.stop("cancel");
  });
});
