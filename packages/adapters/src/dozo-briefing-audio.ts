import { pcmToWav } from "./voice/pcm-wav.js";

export interface SpeechAudio {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * Joins clips of one format into one file the audio player plays through: MP3 frames end to end,
 * or 16-bit PCM WAV samples under one header. Null for a mix of formats, another format (an Ogg
 * stream would need remuxing), or WAV clips whose sample rate or channels differ.
 */
export function joinSpeechClips(clips: readonly SpeechAudio[]): SpeechAudio | null {
  const mimeType = clips[0]?.mimeType;
  if (!mimeType || clips.some((clip) => clip.mimeType !== mimeType)) return null;
  if (mimeType === "audio/mpeg") return { mimeType, bytes: concat(clips.map(mpegFrames)) };
  if (mimeType === "audio/wav") return joinWav(clips);
  return null;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));

/** MPEG-1 and MPEG-2 Layer III bitrates in kbit/s by index. */
const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

/** The byte length of the Layer III frame at `at`, or 0 when no such frame starts there. */
function layer3FrameLength(bytes: Uint8Array, at: number): number {
  if (at + 4 > bytes.byteLength || bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) return 0;
  const versionBits = (bytes[at + 1]! >> 3) & 0b11;
  const layerBits = (bytes[at + 1]! >> 1) & 0b11;
  if (versionBits === 0b01 || layerBits !== 0b01) return 0;
  const version = versionBits === 0b11 ? 1 : versionBits === 0b10 ? 2 : 2.5;
  const bitrate = BITRATES[version === 1 ? 1 : 2][(bytes[at + 2]! >> 4) & 0x0f];
  const sampleRate = SAMPLE_RATES[version][(bytes[at + 2]! >> 2) & 0b11];
  if (!bitrate || !sampleRate) return 0;
  const padding = (bytes[at + 2]! >> 1) & 1;
  return Math.floor(((version === 1 ? 144 : 72) * bitrate * 1000) / sampleRate) + padding;
}

/**
 * A clip's audio frames without its tags or its leading info frame, which states the length of
 * that clip alone: kept in a joined file, players would stop or show the wrong duration.
 */
function mpegFrames(clip: SpeechAudio): Uint8Array {
  let { bytes } = clip;
  if (bytes.byteLength >= 10 && ascii(bytes, 0, "ID3")) {
    const size =
      ((bytes[6]! & 0x7f) << 21) |
      ((bytes[7]! & 0x7f) << 14) |
      ((bytes[8]! & 0x7f) << 7) |
      (bytes[9]! & 0x7f);
    const footer = bytes[5]! & 0x10 ? 10 : 0;
    bytes = bytes.subarray(Math.min(bytes.byteLength, 10 + size + footer));
  }
  if (bytes.byteLength >= 128 && ascii(bytes, bytes.byteLength - 128, "TAG"))
    bytes = bytes.subarray(0, bytes.byteLength - 128);
  const first = layer3FrameLength(bytes, 0);
  if (first > 0) {
    const head = bytes.subarray(4, Math.min(first, 64));
    for (let at = 0; at + 4 <= head.byteLength; at++) {
      if (["Xing", "Info", "VBRI"].some((tag) => ascii(head, at, tag)))
        return bytes.subarray(first);
    }
  }
  return bytes;
}

interface WavPcm {
  sampleRate: number;
  channels: number;
  data: Uint8Array;
}

/** A 16-bit PCM WAV file's format and samples; undefined for anything else. */
function wavPcm(bytes: Uint8Array): WavPcm | undefined {
  if (bytes.byteLength < 12 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WAVE")) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: Omit<WavPcm, "data"> | undefined;
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (ascii(bytes, at, "fmt ") && size >= 16 && body + 16 <= bytes.byteLength) {
      if (view.getUint16(body, true) !== 1 || view.getUint16(body + 14, true) !== 16) return;
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
      };
    } else if (ascii(bytes, at, "data")) {
      // A streamed file may not know its length: its samples run to the end.
      return (
        format && { ...format, data: bytes.subarray(body, Math.min(bytes.byteLength, body + size)) }
      );
    }
    at = body + size + (size % 2);
  }
  return;
}

function joinWav(clips: readonly SpeechAudio[]): SpeechAudio | null {
  const parts = clips.map((clip) => wavPcm(clip.bytes));
  const first = parts[0];
  if (
    !first ||
    parts.some(
      (part) => !part || part.sampleRate !== first.sampleRate || part.channels !== first.channels,
    )
  )
    return null;
  // Whole sample frames only, so a clip's stray byte never shifts the next clip's samples.
  const frame = first.channels * 2;
  const whole = (data: Uint8Array) => data.subarray(0, data.byteLength - (data.byteLength % frame));
  return {
    mimeType: "audio/wav",
    bytes: pcmToWav(concat(parts.map((part) => whole(part!.data))), first),
  };
}
