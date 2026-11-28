import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOZO_SEAL, DOZO_SEIGAIHA } from "./dozo-seigaiha.js";

describe("the seigaiha tile", () => {
  const css = readFileSync(new URL("../../ui-web/src/dozo-shell.css", import.meta.url), "utf8");
  const uri = /url\("data:image\/svg\+xml,([^"]+)"\)/.exec(css)?.[1] ?? "";
  const svg = decodeURIComponent(uri);

  it("is the geometry and fade the sidebar stylesheet draws", () => {
    const tile = /<svg[^>]* width='(\d+)' height='(\d+)'/.exec(svg);
    expect([Number(tile?.[1]), Number(tile?.[2])]).toEqual([
      DOZO_SEIGAIHA.tile.width,
      DOZO_SEIGAIHA.tile.height,
    ]);
    expect(svg).not.toMatch(/<(mask|use|defs)/);
    const path = /<path[^>]* stroke-width='([\d.]+)'[^>]* d='([^']*)'/.exec(svg);
    expect(Number(path?.[1])).toBe(DOZO_SEIGAIHA.strokeWidth);

    const number = "(-?\\d+(?:\\.\\d+)?)";
    const arc = new RegExp(
      `M${number} ${number}A${number} ${number} 0 0 1 ${number} ${number}`,
      "g",
    );
    const d = path?.[2] ?? "";
    const arcs = [...d.matchAll(arc)].map((match) => match.slice(1, 7).map(Number) as number[]);
    expect(arcs.length).toBeGreaterThan(0);
    expect(d.replace(arc, "")).toBe("");

    const { tile: size, radii, centers } = DOZO_SEIGAIHA;
    expect(new Set(arcs.map((a) => a[2]))).toEqual(new Set(radii));

    const near = (a: number, b: number) => Math.abs(a - b) <= 0.05;
    for (const [x0 = 0, y0 = 0, r = 0, ry = 0, x1 = 0, y1 = 0] of arcs) {
      expect(ry).toBe(r);
      expect(near(y0, y1)).toBe(true);
      // The arc is the top cap of a circle whose centre sits below its two ends.
      const cx = (x0 + x1) / 2;
      const cy = y0 + Math.sqrt(r * r - ((x1 - x0) / 2) ** 2);
      expect(centers.some(([x, y]) => near(x, cx) && near(y, cy))).toBe(true);
      // Each end meets the edge of the next scale over it: the largest circle of the neighbour
      // half a tile aside and half a tile down.
      const reach = radii[0];
      expect(near(Math.hypot(x0 - (cx - size.width / 2), y0 - (cy + size.height / 2)), reach)).toBe(
        true,
      );
      expect(near(Math.hypot(x1 - (cx + size.width / 2), y1 - (cy + size.height / 2)), reach)).toBe(
        true,
      );
    }
    expect(css).toContain(`height: min(${DOZO_SEIGAIHA.fadeHeight}px, 100%)`);
    expect(css).toContain(`linear-gradient(black ${DOZO_SEIGAIHA.solidUntil * 100}%, transparent)`);
  });
});

describe("the seal red", () => {
  it("is the value the sidebar stylesheet draws, light and dark", () => {
    const css = readFileSync(new URL("../../ui-web/src/dozo-shell.css", import.meta.url), "utf8");
    expect(css).toContain(`--dozo-seal: light-dark(${DOZO_SEAL.light}, ${DOZO_SEAL.dark});`);
  });
});
