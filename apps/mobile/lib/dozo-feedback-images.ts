import { DOZO_FEEDBACK_IMAGE_MAX_BYTES, DOZO_FEEDBACK_MAX_IMAGES } from "@rakazo/contracts";
import { pickFromLibrary } from "./composer/pick-attachments";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** A picture a person added to a report: its name, and its content as a data URL. */
export interface FeedbackImage {
  name: string;
  url: string;
}

/**
 * Pictures from the photo library, through the picker that attachments use (no new native code).
 * Only PNG, JPEG and WebP within the size of a picture are kept; `refused` is set when the person
 * chose something that was left out. The server checks the bytes again.
 */
export async function pickFeedbackImages(
  existing: number,
): Promise<{ images: FeedbackImage[]; refused: boolean }> {
  const picked = await pickFromLibrary(
    existing,
    DOZO_FEEDBACK_IMAGE_MAX_BYTES,
    DOZO_FEEDBACK_MAX_IMAGES,
  );
  const usable = picked.attachments.filter((file) => IMAGE_TYPES.has(file.mimeType));
  return {
    images: usable.map((file) => ({
      name: file.name,
      url: `data:${file.mimeType};base64,${file.contentBase64}`,
    })),
    refused: picked.skipped.length > 0 || usable.length < picked.attachments.length,
  };
}
