/** Cuts made by upstream's `truncate`, counted so a card built right now can say whether it cut. */
let cuts = 0;

/** How many cuts `dozoTruncate` has made so far. */
export function approvalCuts(): number {
  return cuts;
}

/**
 * Upstream's `truncate` (approval-ask.ts calls this), which also counts each cut. A card's text
 * is only ever cut here, so a count that did not move means the card shows everything.
 */
export function dozoTruncate(
  value: string,
  maxLength: number,
  sliceWellFormed: (text: string, length: number) => string,
): string {
  if (value.length <= maxLength) return value;
  cuts++;
  return `${sliceWellFormed(value, maxLength)}…`;
}
