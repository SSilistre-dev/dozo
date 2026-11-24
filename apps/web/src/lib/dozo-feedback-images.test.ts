// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { addFeedbackImages, feedbackImageBytes } from "./dozo-feedback-images";

const file = (type: string, size = 10, name = "a") =>
  new File([new Uint8Array(size)], name, { type });

describe("addFeedbackImages", () => {
  it("reads a PNG, JPEG or WebP as a data URL under its name", async () => {
    const { images, refused } = await addFeedbackImages(
      [],
      [file("image/png", 3, "a.png"), file("image/jpeg"), file("image/webp")],
    );
    expect(refused).toBe(false);
    expect(images.map((image) => image.name)).toEqual(["a.png", "a", "a"]);
    expect(images[0]?.url).toBe("data:image/png;base64,AAAA");
  });

  it("leaves out a GIF, an SVG and anything that is not a picture, and says so", async () => {
    const { images, refused } = await addFeedbackImages(
      [],
      [file("image/gif"), file("image/svg+xml"), file("text/plain"), file("image/png")],
    );
    expect(images).toHaveLength(1);
    expect(refused).toBe(true);
  });

  it("leaves out a picture over 3 MB and any that would pass three or 8 MB together", async () => {
    const big = file("image/png", 3 * 1024 * 1024 + 1);
    expect((await addFeedbackImages([], [big])).images).toHaveLength(0);
    const four = await addFeedbackImages(
      [],
      [1, 2, 3, 4].map(() => file("image/png")),
    );
    expect(four.images).toHaveLength(3);
    expect(four.refused).toBe(true);
    const near = file("image/png", 3 * 1024 * 1024);
    const together = await addFeedbackImages([], [near, near, near]);
    expect(together.images).toHaveLength(2);
    expect(together.refused).toBe(true);
  });

  it("counts what is already there", async () => {
    const { images } = await addFeedbackImages(
      [{ name: "x", url: "data:image/png;base64,AAAA" }],
      [file("image/png"), file("image/png"), file("image/png")],
    );
    expect(images).toHaveLength(3);
  });

  it("leaves out a file that cannot be read", async () => {
    const broken = file("image/png");
    broken.arrayBuffer = () => Promise.reject(new Error("gone"));
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function () {
      // The reader's own failure path, as a file removed after it was chosen would take.
      Object.defineProperty(this, "error", { value: new Error("gone") });
      queueMicrotask(() => this.onerror?.(new ProgressEvent("error") as never));
    };
    try {
      const { images, refused } = await addFeedbackImages([], [broken]);
      expect([images.length, refused]).toEqual([0, true]);
    } finally {
      FileReader.prototype.readAsDataURL = original;
    }
  });
});

describe("feedbackImageBytes", () => {
  it("is the picture's own bytes", () => {
    expect([...feedbackImageBytes({ name: "a", url: "data:image/png;base64,AAEC" })]).toEqual([
      0, 1, 2,
    ]);
  });
});
