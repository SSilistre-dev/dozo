import { bestEffort } from "@rakazo/logging/best-effort";
import {
  DOZO_FEEDBACK_IMAGE_MAX_BYTES,
  DOZO_FEEDBACK_IMAGES_MAX_BYTES,
  DOZO_FEEDBACK_MAX_IMAGES,
} from "@rakazo/contracts";

/** What the picker offers: the kinds the server accepts; it checks the bytes again. */
export const FEEDBACK_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
const TYPES = new Set(FEEDBACK_IMAGE_ACCEPT.split(","));

/** A picture a person added to a report: its name, and its content as a data URL. */
export interface FeedbackImage {
  name: string;
  url: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * The pictures to add to those already there, and whether any file was left out: one that is not
 * a PNG, JPEG or WebP, one over the size of a picture or of all together, one past the count, or
 * one that cannot be read.
 */
export async function addFeedbackImages(
  existing: readonly FeedbackImage[],
  files: readonly File[],
): Promise<{ images: FeedbackImage[]; refused: boolean }> {
  const images = [...existing];
  let bytes = existing.reduce((sum, image) => sum + (image.url.length * 3) / 4, 0);
  let refused = false;
  for (const file of files) {
    const fits =
      images.length < DOZO_FEEDBACK_MAX_IMAGES &&
      TYPES.has(file.type) &&
      file.size <= DOZO_FEEDBACK_IMAGE_MAX_BYTES &&
      bytes + file.size <= DOZO_FEEDBACK_IMAGES_MAX_BYTES;
    const url = fits ? ((await bestEffort("read a feedback image", readAsDataUrl(file))) ?? null) : null;
    if (url === null) {
      refused = true;
      continue;
    }
    images.push({ name: file.name, url });
    bytes += file.size;
  }
  return { images, refused };
}

/** The picture as the bytes to save, for a server that sends no mail. */
export function feedbackImageBytes(image: FeedbackImage): Uint8Array {
  return Uint8Array.from(atob(image.url.slice(image.url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
}
