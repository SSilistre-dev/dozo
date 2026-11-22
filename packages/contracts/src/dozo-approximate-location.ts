/**
 * A place as a bot may see it without asking for precise: about a kilometre wide at any latitude.
 * The phone rounds its reading with this, and the server rounds what it gets again with it.
 */

/** The least accuracy an approximate place claims. */
export const APPROXIMATE_LOCATION_METERS = 1_000;
/** 0.01° of latitude is about 1.1 km everywhere. */
const LATITUDE_STEP = 0.01;
/**
 * A degree of longitude narrows towards the poles, so its step widens by 1/cos(latitude), up to
 * this at the poles themselves, where every longitude is the same place.
 */
const LONGITUDE_STEP_MAX = 10;

const degrees = (value: number) => Number(value.toFixed(6)) || 0;

/**
 * Latitude to 0.01°, longitude to a step about as wide on the ground (kept within ±180°), and an
 * accuracy of at least a kilometre, or the reading's own when it is worse.
 */
export function approximateLocation(
  latitude: number,
  longitude: number,
  accuracyMeters?: number | null,
): { latitude: number; longitude: number; accuracyMeters: number } {
  const near = degrees(Math.round(latitude / LATITUDE_STEP) * LATITUDE_STEP);
  const step = Math.min(LONGITUDE_STEP_MAX, LATITUDE_STEP / Math.cos((near * Math.PI) / 180));
  let east = Math.round(longitude / step) * step;
  if (east > 180) east -= 360;
  if (east < -180) east += 360;
  return {
    latitude: near,
    longitude: degrees(east),
    accuracyMeters: Math.max(APPROXIMATE_LOCATION_METERS, accuracyMeters ?? 0),
  };
}
