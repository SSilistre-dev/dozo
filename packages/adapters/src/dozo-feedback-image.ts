import { DOZO_FEEDBACK_IMAGE_MAX_BYTES } from "@rakazo/contracts";
import { dozoAvatarImageBytes } from "./dozo-avatar-upload.js";

/** A screenshot is never larger than an 8K display; a bigger one is refused before it is decoded. */
const MAX_INPUT_PIXELS = 40_000_000;
/** The longest side kept: more detail than a person reading a report can use. */
const MAX_SIDE = 2560;

/** One picture of a report, as the mail carries it. */
export interface FeedbackImage {
  filename: string;
  contentType: string;
  /** Base64. */
  content: string;
}

const KINDS = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const;
const KIND = /^data:image\/(png|jpeg|webp);base64,/;

/**
 * The picture to attach for one a person sends, or null when it is not a PNG, JPEG or WebP that
 * its own bytes prove (a GIF, an SVG, which can carry a script, or any other file never is), is
 * over the size or pixel limit, or cannot be decoded. What is attached is always a picture the
 * server drew itself in the same format: turned upright, scaled down when very large, and with
 * every piece of metadata (a photo's location, device and time included) left out.
 */
export async function encodeFeedbackImage(
  value: string,
  index: number,
): Promise<FeedbackImage | null> {
  const kind = KIND.exec(value)?.[1] as keyof typeof KINDS | undefined;
  const bytes = kind ? dozoAvatarImageBytes(value) : null;
  if (!kind || !bytes || bytes.length > DOZO_FEEDBACK_IMAGE_MAX_BYTES) return null;
  // sharp is a native addon; load it only when an image is processed.
  const { default: sharp } = await import("sharp");
  try {
    const picture = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true });
    const encoded =
      kind === "png"
        ? picture.png()
        : kind === "jpeg"
          ? picture.jpeg({ quality: 85 })
          : picture.webp({ quality: 85 });
    const content = (await encoded.toBuffer()).toString("base64");
    return {
      filename: `screenshot-${index + 1}.${kind === "jpeg" ? "jpg" : kind}`,
      contentType: KINDS[kind],
      content,
    };
  } catch {
    return null;
  }
}
