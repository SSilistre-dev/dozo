/** The plugins a category section still has to list once Recommended has shown some of them. */
export function pluginsNotListedAbove<T extends { id: string }>(
  plugins: readonly T[],
  listedAbove: readonly { id: string }[],
): T[] {
  const listed = new Set(listedAbove.map((entry) => entry.id));
  return plugins.filter((entry) => !listed.has(entry.id));
}
