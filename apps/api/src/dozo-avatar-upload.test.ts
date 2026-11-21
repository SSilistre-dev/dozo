import { describe, expect, it } from "vitest";
import { AvatarImageError, dozoAvatarForSave } from "./dozo-avatar-upload.js";

const dataUrl = (type: string, bytes: Uint8Array | string) =>
  `data:image/${type};base64,${Buffer.from(bytes).toString("base64")}`;

describe("an avatar a person saves", () => {
  it("keeps colours, shapes and the picture the bot already has as sent", async () => {
    expect(await dozoAvatarForSave(undefined)).toBeUndefined();
    expect(await dozoAvatarForSave("#8B5CF6")).toBe("#8B5CF6");
    expect(await dozoAvatarForSave("#8B5CF6::shape_3")).toBe("#8B5CF6::shape_3");
    const kept = dataUrl("png", "kept from before");
    expect(await dozoAvatarForSave(kept, kept)).toBe(kept);
  });

  it("stores a new picture only as the server's own re-encoding", async () => {
    // One black pixel.
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const saved = await dozoAvatarForSave(png);
    expect(saved?.startsWith("data:image/webp;base64,")).toBe(true);
    expect(saved).not.toBe(png);
  });

  it("refuses bytes that are not the picture they claim to be", async () => {
    await expect(dozoAvatarForSave(dataUrl("png", "<svg><script/></svg>"))).rejects.toBeInstanceOf(
      AvatarImageError,
    );
    const signatureOnly = dataUrl("png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
    await expect(dozoAvatarForSave(signatureOnly)).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      code: "avatar_image",
    });
  });
});
