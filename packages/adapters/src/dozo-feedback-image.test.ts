import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodeFeedbackImage } from "./dozo-feedback-image.js";

const dataUrl = (type: string, bytes: Uint8Array) =>
  `data:image/${type};base64,${Buffer.from(bytes).toString("base64")}`;
const blank = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } });
const decode = (content: string) => Buffer.from(content, "base64");

describe("a feedback picture", () => {
  it.each([
    ["png", "image/png", "screenshot-1.png"],
    ["jpeg", "image/jpeg", "screenshot-1.jpg"],
    ["webp", "image/webp", "screenshot-1.webp"],
  ] as const)("is redrawn as the same kind of %s", async (kind, contentType, filename) => {
    const bytes = await blank(40, 30)[kind]().toBuffer();
    const image = await encodeFeedbackImage(dataUrl(kind, bytes), 0);
    expect(image).toMatchObject({ filename, contentType });
    const meta = await sharp(decode(image?.content ?? "")).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual([kind, 40, 30]);
  });

  it("numbers the pictures from one", async () => {
    const bytes = await blank(8, 8).png().toBuffer();
    expect((await encodeFeedbackImage(dataUrl("png", bytes), 2))?.filename).toBe(
      "screenshot-3.png",
    );
  });

  it("loses a photo's location, device and other metadata", async () => {
    const photo = await blank(40, 30)
      .jpeg()
      .withExif({ IFD0: { Make: "SecretMaker", Copyright: "SecretOwner" } })
      .toBuffer();
    // The input does carry it, so the test would notice a change that kept it.
    expect(photo.includes(Buffer.from("SecretMaker"))).toBe(true);
    const image = await encodeFeedbackImage(dataUrl("jpeg", photo), 0);
    const out = decode(image?.content ?? "");
    expect(out.includes(Buffer.from("SecretMaker"))).toBe(false);
    expect(out.includes(Buffer.from("SecretOwner"))).toBe(false);
    expect((await sharp(out).metadata()).exif).toBeUndefined();
  });

  it("is turned upright, since the orientation tag goes with the metadata", async () => {
    const photo = await blank(40, 10).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const meta = await sharp(
      decode((await encodeFeedbackImage(dataUrl("jpeg", photo), 0))?.content ?? ""),
    ).metadata();
    expect([meta.width, meta.height]).toEqual([10, 40]);
  });

  it("is scaled down when very large, never up", async () => {
    const wide = await blank(3000, 100).png().toBuffer();
    const meta = await sharp(
      decode((await encodeFeedbackImage(dataUrl("png", wide), 0))?.content ?? ""),
    ).metadata();
    expect([meta.width, meta.height]).toEqual([2560, 85]);
  });

  it("is refused when it is a GIF, an SVG or anything else", async () => {
    const png = await blank(8, 8).png().toBuffer();
    const gif = await blank(8, 8).gif().toBuffer();
    expect(await encodeFeedbackImage(dataUrl("gif", gif), 0)).toBeNull();
    expect(
      await encodeFeedbackImage(dataUrl("svg+xml", Buffer.from("<svg onload='x()'/>")), 0),
    ).toBeNull();
    expect(await encodeFeedbackImage("data:text/html;base64,PGI+", 0)).toBeNull();
    expect(await encodeFeedbackImage("https://example.test/a.png", 0)).toBeNull();
    // The header names one kind and the bytes are another.
    expect(await encodeFeedbackImage(dataUrl("jpeg", png), 0)).toBeNull();
  });

  it("is refused when its bytes are not a picture that decodes", async () => {
    const png = await blank(8, 8).png().toBuffer();
    const cut = png.subarray(0, 40);
    expect(await encodeFeedbackImage(dataUrl("png", cut), 0)).toBeNull();
    expect(await encodeFeedbackImage(dataUrl("png", png.subarray(0, 8)), 0)).toBeNull();
  });

  it("is refused over the size of a picture, or over the pixel limit", async () => {
    const png = await blank(8, 8).png().toBuffer();
    const big = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
    expect(await encodeFeedbackImage(dataUrl("png", big), 0)).toBeNull();
    const bomb = await blank(7000, 7000).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(3 * 1024 * 1024);
    expect(await encodeFeedbackImage(dataUrl("png", bomb), 0)).toBeNull();
  });
});
