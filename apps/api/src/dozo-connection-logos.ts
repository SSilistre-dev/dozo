/**
 * A managed app's logo is drawn by every client from the address its provider gave. Only our own
 * address may reach a browser or phone, so any other becomes no logo and the tile shows its
 * initial instead.
 */
export function withOwnLogosOnly<T extends { logo?: string | null }>(
  items: T[],
  webOrigin: string,
): T[] {
  const own = `${webOrigin.replace(/\/+$/, "")}/`;
  return items.map((item) => (item.logo && !item.logo.startsWith(own) ? { ...item, logo: null } : item));
}

export { recordToolConnected } from "./integrations/tool-connect-analytics.js";
