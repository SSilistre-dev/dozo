import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOZO_SEIGAIHA } from "./dozo-seigaiha.js";

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
    const group = /<g id='s'>(.*?)<\/g>/.exec(svg)?.[1] ?? "";
    expect([...group.matchAll(/<circle r='(\d+)'\/>/g)].map((match) => Number(match[1]))).toEqual(
      DOZO_SEIGAIHA.radii,
    );
    const placed = /<g fill='black' stroke='white' stroke-width='([\d.]+)'>(.*?)<\/g>/.exec(svg);
    expect(Number(placed?.[1])).toBe(DOZO_SEIGAIHA.strokeWidth);
    const centers = [...(placed?.[2] ?? "").matchAll(/<use href='#s'([^>]*)\/>/g)].map((use) => [
      Number(/ x='(-?\d+)'/.exec(use[1] ?? "")?.[1] ?? 0),
      Number(/ y='(-?\d+)'/.exec(use[1] ?? "")?.[1] ?? 0),
    ]);
    expect(centers).toEqual(DOZO_SEIGAIHA.centers);
    expect(css).toContain(`height: min(${DOZO_SEIGAIHA.fadeHeight}px, 100%)`);
    expect(css).toContain(`linear-gradient(black ${DOZO_SEIGAIHA.solidUntil * 100}%, transparent)`);
  });
});
