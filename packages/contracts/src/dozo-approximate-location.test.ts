import { describe, expect, it } from "vitest";
import { APPROXIMATE_LOCATION_METERS, approximateLocation } from "./dozo-approximate-location.js";

/** Metres in one degree of latitude, and of longitude on the equator. */
const DEGREE_METERS = 111_320;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** The narrowest east-west cell a sweep of longitudes at this latitude falls into, in metres. */
function narrowestCell(latitude: number): number {
  const seen = new Set<number>();
  for (let east = 0; east < 20_000; east += 1)
    seen.add(approximateLocation(latitude, east / 1000).longitude);
  const grid = [...seen].sort((a, b) => a - b);
  const rounded = approximateLocation(latitude, 0).latitude;
  const gaps = grid.slice(1).map((value, index) => value - grid[index]!);
  return Math.min(...gaps) * DEGREE_METERS * Math.cos(radians(rounded));
}

describe("an approximate location", () => {
  it("is about a kilometre wide at any latitude", () => {
    for (const latitude of [0, 60, 80, 89.9, -89.9]) {
      const width = narrowestCell(latitude);
      expect(width, String(latitude)).toBeGreaterThanOrEqual(1000);
      expect(width, String(latitude)).toBeLessThan(1300);
    }
  });

  it("rounds latitude to 0.01° and longitude to a step widened by the latitude", () => {
    expect(approximateLocation(0.004, 10.006)).toEqual({
      latitude: 0,
      longitude: 10.01,
      accuracyMeters: APPROXIMATE_LOCATION_METERS,
    });
    // At 60° a degree of longitude is half as wide: the step is 0.02°.
    expect(approximateLocation(60.003, 10.013)).toMatchObject({ latitude: 60, longitude: 10.02 });
    expect(approximateLocation(-0.001, -179.996)).toMatchObject({ latitude: 0, longitude: -180 });
    // Never more than half a step from where the phone is.
    for (const [latitude, longitude] of [
      [80.004, 10.03],
      [89.9, 33.3],
      [-89.9, -120.7],
    ] as const) {
      const near = approximateLocation(latitude, longitude);
      expect(Math.abs(near.latitude - latitude)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(near.longitude - longitude)).toBeLessThan(3);
    }
  });

  it("stays a longitude at the date line and the poles, with a capped step", () => {
    const east = approximateLocation(0, 179.999).longitude;
    expect(east).toBeLessThanOrEqual(180);
    // At 41° the step does not divide 180°: the nearest cell past the date line is on the other side.
    for (const longitude of [179.999, -179.999]) {
      const wrapped = approximateLocation(41.01, longitude).longitude;
      expect(Math.abs(wrapped)).toBeLessThanOrEqual(180);
      expect(Math.abs(wrapped)).toBeGreaterThan(179.9);
    }
    const pole = approximateLocation(90, 123.4);
    expect(pole.latitude).toBe(90);
    expect(pole.longitude).toBeGreaterThanOrEqual(-180);
    expect(pole.longitude).toBeLessThanOrEqual(180);
    expect(approximateLocation(89.999, 175).longitude).toBeLessThanOrEqual(180);
  });

  it("says at least a kilometre of accuracy, or what the phone said when worse", () => {
    expect(approximateLocation(1, 1, 12).accuracyMeters).toBe(1000);
    expect(approximateLocation(1, 1, 5000).accuracyMeters).toBe(5000);
    expect(approximateLocation(1, 1, null).accuracyMeters).toBe(1000);
  });
});
