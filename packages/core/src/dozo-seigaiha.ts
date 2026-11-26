/**
 * The seigaiha tile behind the wordmark: scales of three concentric circles, drawn in this order
 * so a later scale covers the earlier ones. The sidebar's stylesheet (`dozo-shell.css`) draws the
 * same geometry as a mask; the mobile inbox header draws it from here.
 */
export const DOZO_SEIGAIHA = {
  tile: { width: 40, height: 20 },
  radii: [20, 14, 8],
  centers: [
    [20, -10],
    [0, 0],
    [40, 0],
    [20, 10],
    [0, 20],
    [40, 20],
    [20, 30],
  ],
  strokeWidth: 1.2,
  /** The pattern covers this many pixels from the top edge, and no more. */
  fadeHeight: 200,
  /** Share of that height where the pattern is fully shown; it fades to nothing below. */
  solidUntil: 0.25,
} as const;

/** The seal red of the wordmark, as `--dozo-seal` in `dozo-shell.css` holds it. */
export const DOZO_SEAL = { light: "#d93f3f", dark: "#e5484d" } as const;
