import { createHash } from "node:crypto";
import type { PluginMarketplaceCatalog, PluginMarketplaceEntry } from "@rakazo/contracts";
import { PluginMarketplaceCatalogSchema } from "@rakazo/contracts";
import { comparePlugins, matchesPluginQuery } from "@rakazo/core";
import type { HeldLease, Prisma, PrismaClient } from "@rakazo/db";
import { assertLeaseHeld, LeaseHeldError, readJsonColumn, withLease } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { createFaviconResolver } from "./favicon.js";
import type { PluginTextReader } from "./plugin-connectors.js";
import { createPluginMarketplace } from "./plugin-marketplace.js";
import { fetchSafeWebBytes, fetchSafeWebText } from "./web-ssrf.js";

/**
 * The plugin catalog kept in Postgres, so no request waits on the public registries: the API loads
 * the last copy when it starts, serves it whatever its age, and refreshes it in the background, one
 * process at a time. Logos and site icons are fetched once, made small and served from our own
 * domain under their content hash.
 */

const SNAPSHOT_KEY = "plugin-marketplace";
const LEASE_KEY = "dozo:plugin-catalog-refresh";
/** A complete copy younger than this is not refreshed. */
export const CATALOG_REFRESH_MS = 30 * 60_000;
/**
 * After a failed or partial refresh, every process waits this long before the next try, doubling
 * with each failure in a row up to `CATALOG_RETRY_MAX_MS`. The count lives in the stored row.
 */
export const CATALOG_RETRY_MS = 5 * 60_000;
const CATALOG_RETRY_MAX_MS = 6 * 60 * 60_000;
/**
 * A registry listing fewer than half the plugins it listed last time is kept at its last listing
 * (a broken or emptied index must not wipe it), unless it has done so this many refreshes in a row.
 */
export const CATALOG_SHRINK_ACCEPTED_AFTER = 3;
const IMAGE_FOUND_TTL_MS = 7 * 24 * 60 * 60_000;
const IMAGE_MISSING_TTL_MS = 24 * 60 * 60_000;
const IMAGE_CONCURRENCY = 6;
const IMAGE_MAX_BYTES = 512 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 8_000;
/** Shown at 40 and 56 px with padding; 96 px covers both on a 2x screen. */
export const CATALOG_IMAGE_SIZE = 96;
const IMAGE_MAX_INPUT_PIXELS = 4096 * 4096;
const IMAGE_MAX_OUTPUT_BYTES = 32 * 1024;
/** Images are kept for this many sources at most, so the table stays under about 19 MB. */
export const CATALOG_MAX_IMAGES = 600;
export const CATALOG_IMAGE_TYPE = "image/webp";
const IMAGE_FILE = /^([a-f0-9]{64})\.webp$/;
/** Answers that mean a source has no image, as opposed to a failure worth trying again. */
const NO_IMAGE = /^(Request failed: HTTP (404|410)|Not a registry logo)$/;

type CatalogStore = Pick<PrismaClient, "dozoCatalogSnapshot" | "dozoCatalogImage" | "$transaction">;
type RefreshLease = Pick<HeldLease, "key" | "fence" | "signal">;

export type PersistentPluginMarketplaceOptions = {
  prisma: CatalogStore;
  /** Reads registry files; defaults to the SSRF-checked public fetch. */
  read?: PluginTextReader;
  /** The public address of a stored image file (`<hash>.webp`). */
  imageUrl: (file: string) => string;
  /** Runs one refresh while this process alone holds the refresh; defaults to a Postgres lease. */
  exclusive?: <T>(work: (lease: RefreshLease) => Promise<T>) => Promise<T>;
  /** Fetches a logo's bytes; defaults to the SSRF-checked public fetch. */
  fetchImage?: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  /**
   * A site's icon as a data URL, or null when it has none; throws when the lookup could not be
   * made. Defaults to the shared favicon resolver.
   */
  siteIcon?: (origin: string) => Promise<string | null>;
  now?: () => number;
};

type Snapshot = {
  catalog: PluginMarketplaceCatalog;
  refreshedAt: number;
  failures: number;
  retryAt: number;
};

const publicRead: PluginTextReader = async (url, maxBytes, signal) =>
  (await fetchSafeWebText(url, { maxBytes, signal })).body;

/** Registry logos are files in the registry repositories; nothing else is fetched as one. */
const LOGO_HOST = "raw.githubusercontent.com";

async function publicImage(url: string, signal: AbortSignal): Promise<Uint8Array> {
  if (new URL(url).hostname !== LOGO_HOST) throw new Error("Not a registry logo");
  const response = await fetchSafeWebBytes(url, {
    maxBytes: IMAGE_MAX_BYTES,
    timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
    allowedPorts: [443],
    signal,
    headers: { accept: "image/*" },
  });
  return response.body;
}

/** A refresh lease long enough for one cold registry read; it is renewed while the work runs. */
function postgresExclusive(prisma: PrismaClient) {
  return <T>(work: (lease: RefreshLease) => Promise<T>) =>
    withLease(prisma, LEASE_KEY, { ttlMs: 60_000 }, work);
}

function defaultSiteIcon() {
  const resolver = createFaviconResolver();
  return async (origin: string) => {
    const answer = await resolver.favicon(origin);
    if (answer.retry) throw new Error("Site icon lookup was busy");
    return answer.icon;
  };
}

export function createPersistentPluginMarketplace(options: PersistentPluginMarketplaceOptions) {
  const { prisma, imageUrl } = options;
  const now = options.now ?? Date.now;
  const read = options.read ?? publicRead;
  const exclusive = options.exclusive ?? postgresExclusive(prisma as PrismaClient);
  const fetchImage = options.fetchImage ?? publicImage;
  const siteIcon = options.siteIcon ?? defaultSiteIcon();
  let snapshot: Snapshot | null = null;
  /** Image source (a logo URL or `site:<origin>`) to its stored file name. */
  let images = new Map<string, string>();
  let refreshing: Promise<void> | null = null;
  /** Keeps a stale copy from sending every request to the database while a retry is due. */
  let nextAttemptAt = 0;
  const unreadable = new Map<string, number>();

  /** Writes only while this process still holds the refresh. */
  const guarded = <T>(lease: RefreshLease, write: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await assertLeaseHeld(tx, lease);
      return write(tx);
    });

  async function load(): Promise<void> {
    const row = await prisma.dozoCatalogSnapshot.findUnique({ where: { key: SNAPSHOT_KEY } });
    // A copy of an older shape counts as none: the next refresh replaces it.
    const catalog =
      row &&
      readJsonColumn(
        PluginMarketplaceCatalogSchema.nullable(),
        row.data,
        { table: "dozo_catalog_snapshots", column: "data", id: row.key },
        { fallback: null },
      );
    if (row && catalog) {
      snapshot = {
        catalog,
        refreshedAt: row.refreshedAt.getTime(),
        failures: row.failures,
        retryAt: row.retryAt?.getTime() ?? 0,
      };
      nextAttemptAt = Math.max(nextAttemptAt, snapshot.retryAt);
    }
    await loadImages();
  }

  async function loadImages(): Promise<void> {
    const sources = snapshot ? imageSources(snapshot.catalog.entries) : [];
    if (!sources.length) return;
    const rows = await prisma.dozoCatalogImage.findMany({
      where: { source: { in: sources }, hash: { not: null } },
      select: { source: true, hash: true },
    });
    images = new Map(rows.map((row) => [row.source, `${row.hash}.webp`]));
  }

  const loaded = bestEffort("load the stored plugin catalog", load());

  function stale(): boolean {
    return !snapshot || now() - snapshot.refreshedAt >= CATALOG_REFRESH_MS;
  }

  /** Due when stale and no earlier failure asked every process to wait. */
  function due(): boolean {
    return stale() && now() >= (snapshot?.retryAt ?? 0);
  }

  /** Starts a background refresh unless one runs here or one is not due yet. */
  function refreshSoon(): Promise<void> {
    if (refreshing) return refreshing;
    if (now() < nextAttemptAt) return Promise.resolve();
    nextAttemptAt = now() + CATALOG_RETRY_MS;
    refreshing = bestEffort("refresh the plugin catalog", refresh()).then(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function refresh(): Promise<void> {
    // Another process may have refreshed it, or failed and set a time to retry, meanwhile.
    await load();
    if (!due()) return;
    try {
      await exclusive(async (lease) => {
        await load();
        if (!due()) return;
        await fetchCatalog(lease);
        await storeImages(lease);
      });
    } catch (error) {
      if (!(error instanceof LeaseHeldError)) throw error;
    }
  }

  async function fetchCatalog(lease: RefreshLease): Promise<void> {
    const failures: string[] = [];
    const logged: PluginTextReader = (url, maxBytes, signal) =>
      read(url, maxBytes, signal).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // A file a plugin does not have is an answer, not a failure.
        if (message !== "Request failed: HTTP 404") failures.push(message);
        throw error;
      });
    const fresh = await createPluginMarketplace(logged).catalog("");
    lease.signal.throwIfAborted();
    const previous = snapshot?.catalog.entries ?? [];
    const failed = new Set(fresh.unavailableRegistries);
    const count = (entries: PluginMarketplaceEntry[], registry: string) =>
      entries.filter((entry) => entry.registry === registry).length;
    const shrunk = [...new Set(previous.map((entry) => entry.registry))].filter(
      (registry) =>
        !failed.has(registry) && count(fresh.entries, registry) * 2 < count(previous, registry),
    );
    const failuresInRow = snapshot?.failures ?? 0;
    // A shrink that repeats with every file read is believed in the end.
    const shrinkBelieved = failures.length === 0 && failuresInRow >= CATALOG_SHRINK_ACCEPTED_AFTER;
    const keepAll = failures.length > 0;
    const keep = new Set([...failed, ...(shrinkBelieved ? [] : shrunk)]);
    // A read that failed may have left any plugin out, so the last listing fills the gaps.
    const listed = new Set(fresh.entries.map((entry) => entry.id));
    const kept = previous.filter(
      (entry) => !listed.has(entry.id) && (keepAll || keep.has(entry.registry)),
    );
    const catalog: PluginMarketplaceCatalog = {
      entries: [...fresh.entries, ...kept].sort(comparePlugins),
      unavailableRegistries: fresh.unavailableRegistries.filter(
        (name) => !kept.some((entry) => entry.registry === name),
      ),
      skippedEntries: fresh.skippedEntries,
    };
    const complete = keep.size === 0 && !keepAll;
    const failuresNow = complete ? 0 : failuresInRow + 1;
    const retryAt = complete
      ? null
      : new Date(now() + Math.min(CATALOG_RETRY_MAX_MS, CATALOG_RETRY_MS * 2 ** (failuresNow - 1)));
    if (!complete) {
      getLogger().warn("plugin catalog: refresh incomplete, keeping the last listing", {
        registries: [...failed],
        shrunk,
        failure: failures[0],
        failures: failures.length,
        failuresInRow: failuresNow,
      });
    }
    const refreshedAt = new Date(complete ? now() : (snapshot?.refreshedAt ?? 0));
    const row = { data: catalog, refreshedAt, failures: failuresNow, retryAt };
    await guarded(lease, (tx) =>
      tx.dozoCatalogSnapshot.upsert({
        where: { key: SNAPSHOT_KEY },
        create: { key: SNAPSHOT_KEY, ...row },
        update: row,
      }),
    );
    snapshot = {
      catalog,
      refreshedAt: refreshedAt.getTime(),
      failures: failuresNow,
      retryAt: retryAt?.getTime() ?? 0,
    };
    nextAttemptAt = snapshot.retryAt;
  }

  /**
   * Fetches the logos and site icons not stored yet, or stored long enough ago to check again, and
   * drops the stored images of sources the catalog no longer lists.
   */
  async function storeImages(lease: RefreshLease): Promise<void> {
    const sources = snapshot ? imageSources(snapshot.catalog.entries) : [];
    const rows = await prisma.dozoCatalogImage.findMany({
      where: { source: { in: sources } },
      select: { source: true, hash: true, checkedAt: true },
    });
    const checked = new Map(rows.map((row) => [row.source, row]));
    const queue = sources.filter((source) => {
      const row = checked.get(source);
      if (!row) return true;
      const ttl = row.hash ? IMAGE_FOUND_TTL_MS : IMAGE_MISSING_TTL_MS;
      return now() - row.checkedAt.getTime() >= ttl;
    });
    await Promise.all(
      Array.from({ length: IMAGE_CONCURRENCY }, async () => {
        for (let source = queue.shift(); source; source = queue.shift()) {
          lease.signal.throwIfAborted();
          let body: Uint8Array<ArrayBuffer> | null;
          try {
            body = await sourceImage(source, lease.signal);
          } catch (error) {
            // Not an answer: the stored row, a good image included, stays as it is and the
            // source is tried again with the next refresh.
            getLogger().warn("plugin catalog: image fetch failed", { source, error });
            continue;
          }
          const hash = body && createHash("sha256").update(body).digest("hex");
          const data = { hash, body, checkedAt: new Date(now()) };
          await guarded(lease, (tx) =>
            tx.dozoCatalogImage.upsert({
              where: { source },
              create: { source, ...data },
              update: data,
            }),
          );
        }
      }),
    );
    await guarded(lease, (tx) =>
      tx.dozoCatalogImage.deleteMany({ where: { source: { notIn: sources } } }),
    );
    await loadImages();
  }

  /** The image for a source, null when it has none, or a throw when that could not be told. */
  async function sourceImage(
    source: string,
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    if (source.startsWith("site:")) {
      const icon = await siteIcon(source.slice(5));
      const base64 = icon?.match(/^data:image\/png;base64,(.+)$/)?.[1];
      return base64 ? catalogImage(Buffer.from(base64, "base64")) : null;
    }
    let bytes: Uint8Array;
    try {
      bytes = await fetchImage(source, signal);
    } catch (error) {
      if (error instanceof Error && NO_IMAGE.test(error.message)) return null;
      throw error;
    }
    return catalogImage(bytes);
  }

  function withOwnImages(entry: PluginMarketplaceEntry): PluginMarketplaceEntry {
    const source = imageSource(entry);
    const file = source && images.get(source);
    // Never the registry's own address: a logo not stored yet falls back to the site icon.
    return { ...entry, logo: file ? imageUrl(file) : null };
  }

  // Started with the API, so the first visitor after a restart finds the catalog loaded.
  void loaded.then(() => (due() ? refreshSoon() : undefined));

  return {
    /** Answers from the stored copy at once; a stale or missing one is refreshed in the background. */
    async catalog(query: string): Promise<PluginMarketplaceCatalog> {
      await loaded;
      if (due()) void refreshSoon();
      if (!snapshot) {
        // Nothing stored yet (a new deployment's first minute): every registry reads as unavailable.
        return createPluginMarketplace(() => Promise.reject(new Error("Not loaded yet"))).catalog(
          query,
        );
      }
      const at = now();
      return {
        ...snapshot.catalog,
        entries: snapshot.catalog.entries
          .filter((entry) => (unreadable.get(entry.source) ?? 0) <= at)
          .filter((entry) => matchesPluginQuery(entry, query))
          .map(withOwnImages),
      };
    },
    /** A listed plugin that fails to preview, or would install only partly, leaves browse for an hour. */
    markUnreadable(source: string) {
      unreadable.set(source, now() + 60 * 60_000);
    },
    clearUnreadable(source: string) {
      unreadable.delete(source);
    },
    /** Test seam: resolves once the running refresh, if any, has finished. */
    settled: async () => {
      await loaded;
      await refreshing;
    },
  };
}

/**
 * What an entry's picture is made from: its registry logo, else its site's icon. The site is the
 * one the web and mobile clients would ask the favicon lookup for; repository hosts would give
 * every plugin the same mark, so they never stand in for a site.
 */
export function imageSource(
  entry: Pick<PluginMarketplaceEntry, "logo" | "homepage" | "domains">,
): string | null {
  if (entry.logo) return entry.logo;
  const domain = entry.domains[0]?.replace(/^https?:\/\//, "");
  try {
    const site = domain
      ? new URL(`https://${domain}`)
      : entry.homepage && !new URL(entry.homepage).hostname.endsWith("github.com")
        ? new URL(entry.homepage)
        : null;
    return site ? `site:${site.protocol}//${site.host}/` : null;
  } catch {
    return null;
  }
}

/** The sources that get an image, in catalog order, at most `CATALOG_MAX_IMAGES` of them. */
function imageSources(entries: PluginMarketplaceEntry[]): string[] {
  const sources = new Set(entries.map(imageSource).filter((source) => source !== null));
  return [...sources].slice(0, CATALOG_MAX_IMAGES);
}

type ImageKind = "png" | "jpeg" | "gif" | "webp" | "svg";

function sniff(bytes: Uint8Array): ImageKind | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/**
 * An SVG is drawn only when it cannot reach outside itself: no DTD, entities or style imports, and
 * every link and `url()` points inside the document or at inline data.
 */
function selfContainedSvg(text: string): boolean {
  if (/<!DOCTYPE|<!ENTITY|@import/i.test(text)) return false;
  if (/href\s*=\s*["']?(?!["']?\s*(?:#|data:))/i.test(text)) return false;
  return !/url\(\s*["']?(?!\s*["']?(?:#|data:))/i.test(text);
}

/**
 * Turns a fetched logo into the small WebP we serve, or null when it is not an image we accept.
 * The bytes decide the format, whatever type the server declared. SVG is drawn to pixels here, so
 * no browser ever receives markup from a registry.
 */
export async function catalogImage(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer> | null> {
  const kind = sniff(bytes);
  if (!kind || bytes.length > IMAGE_MAX_BYTES) return null;
  if (kind === "svg" && !selfContainedSvg(new TextDecoder().decode(bytes))) return null;
  // sharp is a native addon; load it only when an image is processed.
  const { default: sharp } = await import("sharp");
  const input = { limitInputPixels: IMAGE_MAX_INPUT_PIXELS, animated: false };
  try {
    // An SVG's declared size is only read here, not drawn, so the pixel limit applies to the
    // drawing below, at the size it is drawn.
    let image = sharp(bytes, kind === "svg" ? { ...input, limitInputPixels: false } : input);
    const { width = 0, height = 0 } = await image.metadata();
    if (width < 1 || height < 1) return null;
    // Vector art is drawn at the density that gives the output size, never enlarged from pixels.
    if (kind === "svg") {
      const density = Math.min(
        2400,
        Math.max(1, (72 * CATALOG_IMAGE_SIZE) / Math.max(width, height)),
      );
      image = sharp(bytes, { ...input, density });
    }
    const out = await image
      .resize(CATALOG_IMAGE_SIZE, CATALOG_IMAGE_SIZE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer();
    return out.length <= IMAGE_MAX_OUTPUT_BYTES ? new Uint8Array(out) : null;
  } catch {
    // Truncated, corrupt or over the pixel limit.
    return null;
  }
}

/** A stored image by its served file name, or null for any name that is not one. */
export async function storedCatalogImage(
  prisma: Pick<PrismaClient, "dozoCatalogImage">,
  file: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const hash = IMAGE_FILE.exec(file)?.[1];
  if (!hash) return null;
  const row = await prisma.dozoCatalogImage.findFirst({
    where: { hash },
    select: { body: true },
  });
  return row?.body ?? null;
}
