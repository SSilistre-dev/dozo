import { describe, expect, it } from "vitest";
import { joinSpeechClips } from "./dozo-briefing-audio.js";
import { pcmToWav } from "./voice/pcm-wav.js";

/** A 128 kbit/s, 44.1 kHz MPEG-1 Layer III frame (417 bytes), filled after its header. */
function frame(fill: number, tag?: string) {
  const bytes = new Uint8Array(417).fill(fill);
  bytes.set([0xff, 0xfb, 0x90, 0x00]);
  if (tag)
    bytes.set(
      [...tag].map((char) => char.charCodeAt(0)),
      36,
    );
  return bytes;
}
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};
/** An ID3v2 tag of `size` bytes after its header. */
const id3 = (size: number) =>
  join(Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, size]), new Uint8Array(size));
const id3v1 = () => join(Uint8Array.from([0x54, 0x41, 0x47]), new Uint8Array(125));
const mp3 = (bytes: Uint8Array) => ({ bytes, mimeType: "audio/mpeg" });

describe("joining speech clips", () => {
  it("keeps only the audio frames of MP3 clips, without their tags or info frames", () => {
    const joined = joinSpeechClips([
      mp3(join(id3(10), frame(0, "Info"), frame(1))),
      mp3(join(frame(0, "Xing"), frame(2), id3v1())),
      mp3(frame(3)),
    ]);
    expect(joined?.mimeType).toBe("audio/mpeg");
    expect(joined?.bytes).toEqual(join(frame(1), frame(2), frame(3)));
  });

  it("joins 16-bit WAV clips of one format under one header", () => {
    const format = { sampleRate: 24_000, channels: 1 };
    const first = Uint8Array.from([1, 2, 3, 4]);
    const second = Uint8Array.from([5, 6, 7]);
    const joined = joinSpeechClips([
      { bytes: pcmToWav(first, format), mimeType: "audio/wav" },
      { bytes: pcmToWav(second, format), mimeType: "audio/wav" },
    ]);
    expect(joined).toEqual({
      mimeType: "audio/wav",
      bytes: pcmToWav(Uint8Array.from([1, 2, 3, 4, 5, 6]), format),
    });
  });

  it("reads MPEG-2 frames and tags with a footer", () => {
    // 64 kbit/s at 24 kHz: 72 * 64000 / 24000 = 192 bytes.
    const info = new Uint8Array(192);
    info.set([0xff, 0xf3, 0x84, 0x00]);
    info.set(
      [..."Info"].map((char) => char.charCodeAt(0)),
      21,
    );
    const audio = Uint8Array.from([0xff, 0xf3, 0x84, 0x00, 7, 7]);
    const footer = Uint8Array.from([
      0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 2, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const mpeg25 = Uint8Array.from([0xff, 0xe2, 0x90, 0x00, 1]);
    expect(joinSpeechClips([mp3(join(footer, info, audio)), mp3(audio)])?.bytes).toEqual(
      join(audio, audio),
    );
    expect(joinSpeechClips([mp3(mpeg25), mp3(mpeg25)])?.bytes).toEqual(join(mpeg25, mpeg25));
  });

  it("joins no MP3 clips that disagree or start no audio frame", () => {
    const clip = mp3(frame(1));
    const unlike = [
      [0xff, 0xf3, 0x84, 0x00, 1], // MPEG-2
      [0xff, 0xfb, 0x94, 0x00, 1], // 48 kHz
      [0xff, 0xfb, 0x90, 0xc0, 1], // mono
      [0xff, 0xea, 0x90, 0x00, 2], // a reserved version
      [0xff, 0xfd, 0x90, 0x00, 3], // layer II
      [0xff, 0xfb, 0x00, 0x00, 4], // a free bitrate
      [0xff, 0xfb, 0x9c, 0x00, 5], // a reserved sample rate
      [0x00, 0x01, 0x02, 0x03, 6], // no sync
    ];
    for (const bytes of unlike)
      expect(joinSpeechClips([clip, mp3(Uint8Array.from(bytes))]), String(bytes)).toBeNull();
    expect(joinSpeechClips([mp3(frame(0, "Info")), clip])).toBeNull();
  });

  it("reads a WAV file's samples past other chunks, and to its end when the length is unknown", () => {
    const format = { sampleRate: 16_000, channels: 1 };
    const wav = pcmToWav(Uint8Array.from([1, 2]), format);
    const list = Uint8Array.from([0x4c, 0x49, 0x53, 0x54, 1, 0, 0, 0, 9, 0]);
    const withList = join(wav.subarray(0, 36), list, wav.subarray(36), Uint8Array.from([3, 4]));
    new DataView(withList.buffer).setUint32(36 + list.byteLength + 4, 0xffffffff, true);
    expect(joinSpeechClips([{ bytes: withList, mimeType: "audio/wav" }])?.bytes).toEqual(
      pcmToWav(Uint8Array.from([1, 2, 3, 4]), format),
    );
    const float = pcmToWav(Uint8Array.from([1, 2]), format);
    new DataView(float.buffer).setUint16(20, 3, true);
    expect(joinSpeechClips([{ bytes: float, mimeType: "audio/wav" }])).toBeNull();
    const ascii = (text: string) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
    const noFormat = join(
      ascii("RIFF"),
      new Uint8Array(4),
      ascii("WAVEdata"),
      Uint8Array.from([2, 0, 0, 0, 1, 2]),
    );
    expect(joinSpeechClips([{ bytes: noFormat, mimeType: "audio/wav" }])).toBeNull();
  });

  it("joins nothing it cannot play through", () => {
    const wav = (sampleRate: number) => ({
      bytes: pcmToWav(new Uint8Array(4), { sampleRate, channels: 1 }),
      mimeType: "audio/wav",
    });
    expect(joinSpeechClips([wav(24_000), wav(16_000)])).toBeNull();
    expect(joinSpeechClips([wav(24_000), mp3(frame(1))])).toBeNull();
    expect(joinSpeechClips([{ bytes: new Uint8Array(4), mimeType: "audio/ogg" }])).toBeNull();
    expect(joinSpeechClips([{ bytes: new Uint8Array(4), mimeType: "audio/wav" }])).toBeNull();
    expect(joinSpeechClips([])).toBeNull();
  });
});
