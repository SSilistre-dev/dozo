/**
 * The order work waiting for a bot starts in: the oldest first, the id breaking a tie. The run that
 * starts when a bot's computer is released and the line people are shown both read it here, so
 * the place shown is the place that comes up.
 */
export function queueStartOrder(): Array<{ createdAt: "asc" } | { id: "asc" }> {
  return [{ createdAt: "asc" }, { id: "asc" }];
}

/** `queueStartOrder` as a comparison of two runs already read. */
export function compareQueueStart(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}
