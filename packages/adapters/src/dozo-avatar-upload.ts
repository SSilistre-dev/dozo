/**
 * An uploaded avatar arrives as a `data:image/...;base64,` value. The header alone proves nothing:
 * any text, an SVG with a script or a web page fits the same pattern. These bytes are used only
 * when their first bytes are the kind of image the header names; the caller then re-encodes them
 * (encodeBotAvatarImage), so what is stored is always an image the server drew itself.
 */
const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

const ascii = (bytes: Uint8Array, from: number, text: string) =>
  [...text].every((char, index) => bytes[from + index] === char.charCodeAt(0));

const SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  png: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"),
  webp: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP"),
};

/** The image's bytes, or null when the value is not a data image of the kind it names. */
export function dozoAvatarImageBytes(value: string): Uint8Array | null {
  const match = DATA_IMAGE.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const bytes = new Uint8Array(Buffer.from(match[2], "base64"));
  return SIGNATURES[match[1]]?.(bytes) ? bytes : null;
}
