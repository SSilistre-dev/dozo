import { dozoAvatarImageBytes } from "./dozo-avatar-upload.js";

/** The stored logo's side in pixels: a square, shown at 24 px, sharp on a 3x screen. */
export const DOZO_ORGANIZATION_LOGO_SIZE = 128;

/** No logo needs more than 5000 × 5000 pixels; a larger one is refused before it is decoded. */
const MAX_INPUT_PIXELS = 25_000_000;

/**
 * The logo to store for one a person uploads, or null when it is not a picture the server can use.
 * The bytes must be the PNG, JPEG, WebP or GIF the header names (an SVG, which can carry a script,
 * never is), and what is stored is always a square WebP the server drew itself: cropped to the
 * middle, the first frame of an animation, and any transparency laid on white, so a dark logo
 * stays visible in the dark theme.
 */
export async function encodeOrganizationLogo(value: string): Promise<string | null> {
  const bytes = dozoAvatarImageBytes(value);
  if (!bytes) return null;
  // sharp is a native addon; load it only when an image is processed.
  const { default: sharp } = await import("sharp");
  let webp: Buffer;
  try {
    webp = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(DOZO_ORGANIZATION_LOGO_SIZE, DOZO_ORGANIZATION_LOGO_SIZE, {
        fit: "cover",
        position: "centre",
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .webp({ quality: 90 })
      .toBuffer();
  } catch {
    return null;
  }
  return `data:image/webp;base64,${webp.toString("base64")}`;
}
