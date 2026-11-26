import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodeBotAvatarImage } from "./bots/bot-avatar.js";
import { dozoAvatarImageBytes } from "./dozo-avatar-upload.js";
import { DOZO_FAKE_IMAGE_BASE64 } from "./dozo-fake-image.js";
import { FakeMediaGenerationProvider } from "./media/media-generation-provider.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

describe("the offline image provider's picture", () => {
  it("is a real PNG that an image decoder reads", async () => {
    const bytes = Buffer.from(DOZO_FAKE_IMAGE_BASE64, "base64");
    const meta = await sharp(bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 8, 8]);
    // Every pixel, not only the header, decodes.
    expect((await sharp(bytes).raw().toBuffer()).length).toBe(8 * 8 * 3);
  });

  // Runs on the branded tree only: an anchored rule gives the provider this picture.
  it("is what the provider returns, and an avatar can be made of it", async () => {
    const { bytes, mimeType } = await new FakeMediaGenerationProvider().generateImage(
      { prompt: "a fox" },
      context,
    );
    expect(mimeType).toBe("image/png");
    expect(Buffer.from(bytes).toString("base64")).toBe(DOZO_FAKE_IMAGE_BASE64);
    const avatar = await encodeBotAvatarImage(bytes);
    expect(dozoAvatarImageBytes(avatar)).not.toBeNull();
    const meta = await sharp(dozoAvatarImageBytes(avatar)!).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 256, 256]);
  });
});
