import { isBotAvatarValue } from "@rakazo/contracts";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { resolveUpdateBotAvatar } from "./bot-avatar.js";
import { dozoAvatarImageBytes } from "./dozo-avatar-upload.js";

const dataUrl = (type: string, bytes: Uint8Array | string) =>
  `data:image/${type};base64,${Buffer.from(bytes).toString("base64")}`;

async function picture(format: "png" | "jpeg" | "webp" | "gif") {
  const image = sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 20, b: 20 } },
  });
  return new Uint8Array(await image.toFormat(format).toBuffer());
}

/** Values the avatar schema takes today from their header alone, none of them a picture. */
const NOT_PICTURES = {
  text: dataUrl("png", "hello"),
  svgWithScript: dataUrl(
    "png",
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  ),
  webPage: dataUrl("gif", "<html><body onload=alert(1)></body></html>"),
  pngCalledJpeg: "",
};

describe("uploaded avatar bytes", () => {
  it("are what the schema lets through on its header alone", async () => {
    NOT_PICTURES.pngCalledJpeg = dataUrl("jpeg", await picture("png"));
    for (const value of Object.values(NOT_PICTURES)) expect(isBotAvatarValue(value)).toBe(true);
    // An SVG named as one is refused by the header already.
    expect(isBotAvatarValue(dataUrl("svg+xml", "<svg/>"))).toBe(false);
  });

  it("are used only when they are the image the header names", async () => {
    for (const format of ["png", "jpeg", "webp", "gif"] as const) {
      const bytes = await picture(format);
      expect(dozoAvatarImageBytes(dataUrl(format, bytes))).toEqual(bytes);
    }
    NOT_PICTURES.pngCalledJpeg = dataUrl("jpeg", await picture("png"));
    for (const value of Object.values(NOT_PICTURES)) expect(dozoAvatarImageBytes(value)).toBeNull();
    expect(dozoAvatarImageBytes(dataUrl("svg+xml", "<svg/>"))).toBeNull();
    expect(dozoAvatarImageBytes("#8B5CF6")).toBeNull();
  });

  it("are checked and re-encoded when a bot sets its own avatar from a data image", async () => {
    const base = { sourceImageArtifactIds: [], loadArtifact: async () => null };
    expect(await resolveUpdateBotAvatar({ ...base, color: NOT_PICTURES.text })).toEqual({
      error: "Could not use that image as an avatar.",
    });
    const real = await resolveUpdateBotAvatar({
      ...base,
      color: dataUrl("png", await picture("png")),
    });
    expect("color" in real && real.color.startsWith("data:image/webp;base64,")).toBe(true);
    // A PNG signature with nothing decodable behind it.
    const truncated = dataUrl(
      "png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(await resolveUpdateBotAvatar({ ...base, color: truncated })).toEqual({
      error: "Could not use that image as an avatar.",
    });
    expect(await resolveUpdateBotAvatar({ ...base, color: "#8B5CF6::shape_3" })).toEqual({
      color: "#8B5CF6::shape_3",
    });
  });
});
