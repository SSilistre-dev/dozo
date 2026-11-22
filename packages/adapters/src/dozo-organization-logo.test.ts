import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DOZO_ORGANIZATION_LOGO_SIZE, encodeOrganizationLogo } from "./dozo-organization-logo.js";

const dataUrl = (type: string, bytes: Uint8Array | string) =>
  `data:image/${type};base64,${Buffer.from(bytes).toString("base64")}`;

async function picture(
  format: "png" | "jpeg" | "webp" | "gif",
  size = { width: 40, height: 20 },
  background = { r: 20, g: 20, b: 20, alpha: 1 },
) {
  const image = sharp({ create: { ...size, channels: 4, background } });
  return new Uint8Array(await image.toFormat(format).toBuffer());
}

async function decoded(logo: string) {
  const bytes = Buffer.from(logo.slice("data:image/webp;base64,".length), "base64");
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return { info, first: [...data.subarray(0, info.channels)] };
}

describe("an uploaded organization logo", () => {
  it.each(["png", "jpeg", "webp", "gif"] as const)(
    "is stored as the server's own square WebP when it is a %s",
    async (format) => {
      const logo = await encodeOrganizationLogo(dataUrl(format, await picture(format)));
      expect(logo).toMatch(/^data:image\/webp;base64,/);
      const { info } = await decoded(logo!);
      expect(info.format).toBe("raw");
      expect([info.width, info.height]).toEqual([
        DOZO_ORGANIZATION_LOGO_SIZE,
        DOZO_ORGANIZATION_LOGO_SIZE,
      ]);
    },
  );

  it("lays a transparent logo on white, so dark ink shows in the dark theme", async () => {
    const clear = await picture("png", { width: 8, height: 8 }, { r: 0, g: 0, b: 0, alpha: 0 });
    const { first, info } = await decoded((await encodeOrganizationLogo(dataUrl("png", clear)))!);
    expect(info.channels).toBe(3);
    for (const channel of first) expect(channel).toBeGreaterThan(245);
  });

  it("refuses an SVG, a script, a page and bytes that are not the image the header names", async () => {
    const refused = [
      dataUrl("svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      dataUrl("png", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      dataUrl("gif", "<html><body onload=alert(1)></body></html>"),
      dataUrl("jpeg", await picture("png")),
      "https://example.test/logo.png",
    ];
    for (const value of refused) expect(await encodeOrganizationLogo(value)).toBeNull();
  });

  it("refuses a picture too large to decode safely, and one that is broken past its header", async () => {
    const huge = await sharp({
      create: { width: 6000, height: 6000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(await encodeOrganizationLogo(dataUrl("png", new Uint8Array(huge)))).toBeNull();
    const broken = (await picture("png")).slice(0, 24);
    expect(await encodeOrganizationLogo(dataUrl("png", broken))).toBeNull();
  });
});
