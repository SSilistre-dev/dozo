import type { PluginMarketplaceCatalog, PluginMarketplaceEntry } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { LeaseHeldError, LeaseLostError } from "@rakazo/db";
import type { TestSink } from "@rakazo/logging";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistentPluginMarketplaceOptions } from "./dozo-plugin-catalog.js";
import {
  CATALOG_IMAGE_SIZE,
  CATALOG_MAX_IMAGES,
  CATALOG_REFRESH_MS,
  CATALOG_RETRY_MS,
  CATALOG_SHRINK_ACCEPTED_AFTER,
  catalogImage,
  createPersistentPluginMarketplace,
  imageSource,
  storedCatalogImage,
} from "./dozo-plugin-catalog.js";
import { createFaviconResolver } from "./favicon.js";
import { fetchSafeWebBytes, fetchSafeWebText } from "./web-ssrf.js";

// The defaults reach the network and Postgres; each is replaced so the tests stay offline.
vi.mock("./web-ssrf.js", async (original) => ({
  ...(await original<typeof import("./web-ssrf.js")>()),
  fetchSafeWebText: vi.fn(),
  fetchSafeWebBytes: vi.fn(),
}));
vi.mock("./favicon.js", async (original) => ({
  ...(await original<typeof import("./favicon.js")>()),
  createFaviconResolver: vi.fn(),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  withLease: vi.fn(
    (
      _prisma: unknown,
      _key: string,
      _options: unknown,
      work: (lease: { key: string; fence: number; signal: AbortSignal }) => unknown,
    ) => work(lease()),
  ),
  // The lease row is not there; a lease whose signal aborted counts as lost.
  assertLeaseHeld: vi.fn(async (_tx: unknown, held: { key: string; signal?: AbortSignal }) => {
    if (held.signal?.aborted) throw new LeaseLostError(held.key);
  }),
}));

function lease(signal = new AbortController().signal) {
  return { key: "dozo:plugin-catalog-refresh", fence: 1, signal };
}

type ImageRow = { source: string; hash: string | null; body: Uint8Array | null; checkedAt: Date };
type SnapshotRow = {
  key: string;
  data: unknown;
  refreshedAt: Date;
  failures: number;
  retryAt: Date | null;
};

/** The two tables in memory, answering the queries the catalog makes. */
function fakeStore(snapshot?: SnapshotRow) {
  const snapshots = new Map<string, SnapshotRow>(snapshot ? [[snapshot.key, snapshot]] : []);
  const images = new Map<string, ImageRow>();
  const prisma = {
    $transaction: vi.fn(async (write: (tx: unknown) => Promise<unknown>) => write(prisma)),
    dozoCatalogSnapshot: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => snapshots.get(where.key)),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { key: string };
          create: SnapshotRow;
          update: Partial<SnapshotRow>;
        }) => {
          const row = snapshots.get(where.key);
          snapshots.set(where.key, row ? { ...row, ...update } : create);
        },
      ),
    },
    dozoCatalogImage: {
      findMany: vi.fn(
        async ({ where }: { where: { source: { in: string[] }; hash?: { not: null } } }) =>
          [...images.values()].filter(
            (row) => where.source.in.includes(row.source) && (!where.hash || row.hash !== null),
          ),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { hash: string } }) =>
          [...images.values()].find((row) => row.hash === where.hash) ?? null,
      ),
      upsert: vi.fn(async ({ create }: { create: ImageRow }) => {
        images.set(create.source, create);
      }),
      deleteMany: vi.fn(async ({ where }: { where: { source: { notIn: string[] } } }) => {
        for (const source of images.keys())
          if (!where.source.notIn.includes(source)) images.delete(source);
      }),
    },
  };
  return { prisma, snapshots, images };
}

function entry(overrides: Partial<PluginMarketplaceEntry> = {}): PluginMarketplaceEntry {
  return {
    id: "Cursor:https://github.com/cursor/plugins#notes",
    name: "notes",
    displayName: "Notes",
    description: "Take notes.",
    keywords: [],
    category: "productivity",
    logo: "https://raw.githubusercontent.com/cursor/plugins/HEAD/notes/logo.png",
    homepage: null,
    domains: [],
    registry: "Cursor",
    source: "https://github.com/cursor/plugins#notes",
    installedSource: "https://github.com/cursor/plugins#notes",
    hasConnector: false,
    skillCount: 1,
    ...overrides,
  };
}

function stored(catalog: Partial<PluginMarketplaceCatalog>, refreshedAt: number): SnapshotRow {
  return {
    key: "plugin-marketplace",
    data: { entries: [], unavailableRegistries: [], skippedEntries: 0, ...catalog },
    refreshedAt: new Date(refreshedAt),
    failures: 0,
    retryAt: null,
  };
}

/** Both registries list one plugin; the first has a logo, the second only a site. */
function registries() {
  return vi.fn(async (url: string, _maxBytes?: number, _signal?: AbortSignal) => {
    if (url.includes("/git/trees/"))
      return JSON.stringify({ tree: [{ path: "notes/skills/plan/SKILL.md", type: "blob" }] });
    if (url.endsWith("plugin-index.json"))
      return JSON.stringify({ plugins: { tasks: { components: { skills: [{}] } } } });
    if (url.endsWith("cursor/plugins/HEAD/.cursor-plugin/marketplace.json"))
      return JSON.stringify({ plugins: [{ name: "notes", source: "notes" }] });
    if (url.endsWith("marketplace.json"))
      return JSON.stringify({
        plugins: [{ name: "tasks", source: "tasks", homepage: "https://tasks.example/start" }],
      });
    if (url.endsWith("notes/.cursor-plugin/plugin.json"))
      return JSON.stringify({ logo: "logo.png" });
    throw new Error("Request failed: HTTP 404");
  });
}

const png = (size = 200) =>
  sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 200, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer()
    .then((buffer) => new Uint8Array(buffer));

const T0 = Date.UTC(2026, 10, 19, 12);
let sink: TestSink;

beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink], level: "debug" }));
});

function setup(
  store: ReturnType<typeof fakeStore>,
  overrides: Partial<PersistentPluginMarketplaceOptions> = {},
) {
  let now = T0;
  const options: PersistentPluginMarketplaceOptions = {
    prisma: store.prisma as never,
    read: registries(),
    imageUrl: (file) => `https://app.example.test/images/${file}`,
    exclusive: (work) => work(lease()),
    fetchImage: vi.fn(async () => png()),
    siteIcon: vi.fn(
      async () => `data:image/png;base64,${Buffer.from(await png(64)).toString("base64")}`,
    ),
    now: () => now,
    ...overrides,
  };
  return {
    options,
    marketplace: createPersistentPluginMarketplace(options),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("stored plugin catalog", () => {
  it("answers after a restart from the stored copy while the registries hang", async () => {
    const store = fakeStore(stored({ entries: [entry({ logo: null })] }, T0 - CATALOG_REFRESH_MS));
    const hanging = deferred<string>();
    const read = vi.fn(() => hanging.promise);
    const { marketplace } = setup(store, { read });
    const catalog = await marketplace.catalog("");
    expect(catalog.entries.map((row) => row.name)).toEqual(["notes"]);
    expect(catalog.unavailableRegistries).toEqual([]);
    // The stale copy is refreshed behind the answer, which did not wait for it.
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
  });

  it("answers at once with nothing stored, reporting the registries unavailable", async () => {
    const store = fakeStore();
    const read = vi.fn(() => deferred<string>().promise);
    const { marketplace } = setup(store, { read });
    const catalog = await marketplace.catalog("");
    expect(catalog.entries).toEqual([]);
    expect(catalog.unavailableRegistries).toEqual(["Cursor", "xAI"]);
  });

  it("warms an empty store at startup and serves logos and site icons from its own address", async () => {
    const store = fakeStore();
    const { marketplace, options } = setup(store);
    await marketplace.settled();
    expect(store.snapshots.get("plugin-marketplace")?.refreshedAt.getTime()).toBe(T0);
    const catalog = await marketplace.catalog("");
    expect(catalog.entries.map((row) => row.name)).toEqual(["notes", "tasks"]);
    for (const row of catalog.entries)
      expect(row.logo).toMatch(/^https:\/\/app\.example\.test\/images\/[a-f0-9]{64}\.webp$/);
    expect(options.fetchImage).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/cursor/plugins/HEAD/notes/logo.png",
      expect.any(AbortSignal),
    );
    expect(options.siteIcon).toHaveBeenCalledWith("https://tasks.example/");
    const file = catalog.entries[0]!.logo!.split("/").pop()!;
    const body = await storedCatalogImage(store.prisma as never, file);
    expect((await sharp(body!).metadata()).width).toBe(CATALOG_IMAGE_SIZE);
    expect(await marketplace.catalog("tasks")).toMatchObject({ entries: [{ name: "tasks" }] });
  });

  it("does not refresh a fresh copy, and never refetches images it has checked", async () => {
    const store = fakeStore();
    const first = setup(store);
    await first.marketplace.settled();
    const read = registries();
    const fetchImage = vi.fn(async () => png());
    const second = setup(store, { read, fetchImage });
    await second.marketplace.catalog("");
    await second.marketplace.settled();
    expect(read).not.toHaveBeenCalled();
    second.advance(CATALOG_REFRESH_MS);
    await second.marketplace.catalog("");
    await second.marketplace.settled();
    expect(read).toHaveBeenCalled();
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("keeps a failed registry's last listing, logs why and retries only after a pause", async () => {
    const kept = entry({ id: "xAI:old", name: "old", registry: "xAI", logo: null });
    const store = fakeStore(stored({ entries: [kept] }, T0 - CATALOG_REFRESH_MS));
    const base = registries();
    const read = vi.fn(async (url: string, max?: number, signal?: AbortSignal) => {
      if (url.includes("xai-org")) throw new Error("Request failed: HTTP 403");
      return base(url, max, signal);
    });
    const { marketplace, advance } = setup(store, { read });
    await marketplace.settled();
    const catalog = await marketplace.catalog("");
    expect(catalog.entries.map((row) => row.name)).toEqual(["notes", "old"]);
    expect(catalog.unavailableRegistries).toEqual([]);
    // A partial refresh leaves the copy stale, so it is tried again.
    expect(store.snapshots.get("plugin-marketplace")?.refreshedAt.getTime()).toBe(
      T0 - CATALOG_REFRESH_MS,
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "plugin catalog: refresh incomplete, keeping the last listing",
      }),
    );
    expect(store.snapshots.get("plugin-marketplace")).toMatchObject({
      failures: 1,
      retryAt: new Date(T0 + CATALOG_RETRY_MS),
    });
    const calls = read.mock.calls.length;
    await marketplace.catalog("");
    await marketplace.settled();
    expect(read).toHaveBeenCalledTimes(calls);
    advance(CATALOG_RETRY_MS);
    await marketplace.catalog("");
    await marketplace.settled();
    const second = read.mock.calls.length;
    expect(second).toBeGreaterThan(calls);
    // Each failure in a row doubles the wait.
    expect(store.snapshots.get("plugin-marketplace")).toMatchObject({
      failures: 2,
      retryAt: new Date(T0 + 3 * CATALOG_RETRY_MS),
    });
    advance(CATALOG_RETRY_MS);
    await marketplace.catalog("");
    await marketplace.settled();
    expect(read).toHaveBeenCalledTimes(second);
  });

  it("shares the wait with every process through the stored row", async () => {
    const store = fakeStore({
      ...stored({ entries: [entry()] }, T0 - CATALOG_REFRESH_MS),
      failures: 4,
      retryAt: new Date(T0 + 60_000),
    });
    const read = registries();
    const { marketplace, advance } = setup(store, { read });
    await marketplace.catalog("");
    await marketplace.settled();
    expect(read).not.toHaveBeenCalled();
    advance(60_000);
    await marketplace.catalog("");
    await marketplace.settled();
    expect(read).toHaveBeenCalled();
    expect(store.snapshots.get("plugin-marketplace")).toMatchObject({ failures: 0, retryAt: null });
  });

  it("keeps the plugins a failed file read may have left out, and does not count it complete", async () => {
    const lost = entry({ id: "Cursor:lost", name: "lost", logo: null });
    const store = fakeStore(stored({ entries: [entry(), lost] }, T0 - CATALOG_REFRESH_MS));
    const base = registries();
    const read = vi.fn(async (url: string, max?: number, signal?: AbortSignal) => {
      if (url.endsWith("tasks/.grok-plugin/plugin.json"))
        throw new Error("Request failed: HTTP 500");
      return base(url, max, signal);
    });
    const { marketplace } = setup(store, { read });
    await marketplace.settled();
    expect((await marketplace.catalog("")).entries.map((row) => row.name).sort()).toEqual([
      "lost",
      "notes",
      "tasks",
    ]);
    expect(store.snapshots.get("plugin-marketplace")).toMatchObject({
      failures: 1,
      refreshedAt: new Date(T0 - CATALOG_REFRESH_MS),
    });
  });

  it("keeps a registry that suddenly lists under half its plugins until the shrink repeats", async () => {
    const old = ["a", "b", "c"].map((name) => entry({ id: `Cursor:${name}`, name, logo: null }));
    const store = fakeStore({
      ...stored({ entries: old }, T0 - CATALOG_REFRESH_MS),
      failures: CATALOG_SHRINK_ACCEPTED_AFTER - 1,
    });
    const { marketplace, advance } = setup(store);
    await marketplace.settled();
    const names = async () => (await marketplace.catalog("")).entries.map((row) => row.name);
    expect((await names()).sort()).toEqual(["a", "b", "c", "notes", "tasks"]);
    advance(CATALOG_RETRY_MS * 2 ** CATALOG_SHRINK_ACCEPTED_AFTER);
    await marketplace.catalog("");
    await marketplace.settled();
    expect((await names()).sort()).toEqual(["notes", "tasks"]);
    expect(store.snapshots.get("plugin-marketplace")).toMatchObject({ failures: 0 });
  });

  it("reports a registry unavailable when it never listed anything", async () => {
    const store = fakeStore();
    const base = registries();
    const read = vi.fn(async (url: string, max?: number, signal?: AbortSignal) => {
      if (url.includes("xai-org")) throw new Error("rate limited");
      return base(url, max, signal);
    });
    const { marketplace } = setup(store, { read });
    await marketplace.settled();
    expect((await marketplace.catalog("")).unavailableRegistries).toEqual(["xAI"]);
  });

  it("leaves the refresh to the process holding it", async () => {
    const store = fakeStore();
    const exclusive = vi.fn(async () => {
      throw new LeaseHeldError("dozo:plugin-catalog-refresh");
    });
    const read = registries();
    const { marketplace } = setup(store, { exclusive, read });
    await marketplace.settled();
    expect(exclusive).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(sink.events.filter((event) => event.level !== "debug")).toEqual([]);
  });

  it("adopts a copy another process stored while it waited for the refresh", async () => {
    const store = fakeStore();
    const read = registries();
    const exclusive: PersistentPluginMarketplaceOptions["exclusive"] = async (work) => {
      store.snapshots.set("plugin-marketplace", stored({ entries: [entry()] }, T0));
      return work(lease());
    };
    const { marketplace } = setup(store, { exclusive, read });
    await marketplace.settled();
    expect(read).not.toHaveBeenCalled();
    expect((await marketplace.catalog("")).entries.map((row) => row.name)).toEqual(["notes"]);
  });

  it("replaces a stored copy of an older shape", async () => {
    const store = fakeStore({
      key: "plugin-marketplace",
      data: { plugins: [] },
      refreshedAt: new Date(T0),
      failures: 0,
      retryAt: null,
    });
    const { marketplace } = setup(store);
    await marketplace.settled();
    expect((await marketplace.catalog("")).entries.map((row) => row.name)).toEqual([
      "notes",
      "tasks",
    ]);
  });

  it("logs a store it cannot read and still answers", async () => {
    const store = fakeStore();
    store.prisma.dozoCatalogSnapshot.findUnique.mockRejectedValue(new Error("database down"));
    const { marketplace } = setup(store);
    expect((await marketplace.catalog("")).entries).toEqual([]);
    await marketplace.settled();
    expect(sink.events.some((event) => event.level === "warn")).toBe(true);
  });

  it("hides a plugin that failed to preview until it is cleared or an hour passes", async () => {
    const store = fakeStore(stored({ entries: [entry()] }, T0));
    const { marketplace, advance } = setup(store);
    const names = async () => (await marketplace.catalog("")).entries.map((row) => row.name);
    marketplace.markUnreadable(entry().source);
    expect(await names()).toEqual([]);
    marketplace.clearUnreadable(entry().source);
    expect(await names()).toEqual(["notes"]);
    marketplace.markUnreadable(entry().source);
    advance(60 * 60_000);
    expect(await names()).toEqual(["notes"]);
  });

  it("records a source without an image and does not link the registry's own address", async () => {
    const store = fakeStore();
    const { marketplace } = setup(store, {
      fetchImage: vi.fn(async () => new TextEncoder().encode("<html>not found</html>")),
      siteIcon: vi.fn(async () => null),
    });
    await marketplace.settled();
    expect((await marketplace.catalog("")).entries.map((row) => row.logo)).toEqual([null, null]);
    expect([...store.images.values()].map((row) => row.hash)).toEqual([null, null]);
  });

  it("writes nothing once the refresh is lost", async () => {
    const store = fakeStore();
    const lost = new AbortController();
    lost.abort();
    const fetchImage = vi.fn(async () => png());
    const { marketplace } = setup(store, {
      exclusive: (work) => work(lease(lost.signal)),
      fetchImage,
    });
    await marketplace.settled();
    expect(store.snapshots.size).toBe(0);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("does not write a snapshot when the lease is gone by the time it commits", async () => {
    const store = fakeStore();
    const lost = new AbortController();
    const read = registries();
    const { marketplace } = setup(store, {
      exclusive: (work) => work(lease(lost.signal)),
      read: vi.fn(async (url: string, max?: number, signal?: AbortSignal) => {
        const text = await read(url, max, signal);
        if (url.endsWith("plugin-index.json")) lost.abort();
        return text;
      }),
    });
    await marketplace.settled();
    expect(store.snapshots.size).toBe(0);
  });

  it("keeps a good image through a failed fetch and records only real misses", async () => {
    const store = fakeStore();
    const first = setup(store);
    await first.marketplace.settled();
    const good = [...store.images.values()].map((row) => [row.source, row.hash]);
    const later = T0 + 8 * 24 * 60 * 60_000;
    store.snapshots.get("plugin-marketplace")!.refreshedAt = new Date(later - CATALOG_REFRESH_MS);
    const second = setup(store, {
      fetchImage: vi.fn(async () => {
        throw new Error("Request timed out");
      }),
      siteIcon: vi.fn(async () => {
        throw new Error("Site icon lookup was busy");
      }),
    });
    second.advance(later - T0);
    await second.marketplace.catalog("");
    await second.marketplace.settled();
    expect([...store.images.values()].map((row) => [row.source, row.hash])).toEqual(good);
    store.snapshots.get("plugin-marketplace")!.refreshedAt = new Date(later - CATALOG_REFRESH_MS);
    const third = setup(store, {
      fetchImage: vi.fn(async () => {
        throw new Error("Request failed: HTTP 404");
      }),
    });
    third.advance(later - T0);
    await third.marketplace.catalog("");
    await third.marketplace.settled();
    const logo = "https://raw.githubusercontent.com/cursor/plugins/HEAD/notes/logo.png";
    expect(store.images.get(logo)?.hash).toBeNull();
  });

  it("drops images of sources the catalog no longer lists and caps how many it keeps", async () => {
    const store = fakeStore();
    store.images.set("https://raw.githubusercontent.com/gone/logo.png", {
      source: "https://raw.githubusercontent.com/gone/logo.png",
      hash: "d".repeat(64),
      body: new Uint8Array([1]),
      checkedAt: new Date(T0),
    });
    const { marketplace } = setup(store);
    await marketplace.settled();
    expect(store.images.has("https://raw.githubusercontent.com/gone/logo.png")).toBe(false);
    expect(store.images.size).toBe(2);

    const many = Array.from({ length: CATALOG_MAX_IMAGES + 1 }, (_, i) =>
      entry({ id: `Cursor:${i}`, name: `p${i}`, logo: null, domains: [`p${i}.example`] }),
    );
    const full = fakeStore(stored({ entries: many }, T0));
    for (const row of many) {
      const source = imageSource(row)!;
      full.images.set(source, {
        source,
        hash: "e".repeat(64),
        body: null,
        checkedAt: new Date(T0),
      });
    }
    const capped = setup(full);
    const logos = (await capped.marketplace.catalog("")).entries.map((row) => row.logo);
    expect(logos.filter(Boolean)).toHaveLength(CATALOG_MAX_IMAGES);
  });
});

describe("defaults", () => {
  it("reads through the SSRF-checked fetch, fetches only registry logos and holds a lease", async () => {
    const base = registries();
    const read = vi.fn(async (url: string, max?: number, signal?: AbortSignal) => {
      if (url.includes("xai-org")) throw new Error("Request failed: HTTP 429");
      return base(url, max, signal);
    });
    vi.mocked(fetchSafeWebText).mockImplementation(
      async (url, options) =>
        ({
          url,
          status: 200,
          body: await read(url, options?.maxBytes ?? 0, options!.signal!),
        }) as never,
    );
    const bytes = await png();
    vi.mocked(fetchSafeWebBytes).mockResolvedValue({ body: bytes } as never);
    const favicon = vi.fn(async (origin: string) =>
      origin.includes("busy") ? { icon: null, retry: true as const } : { icon: null },
    );
    vi.mocked(createFaviconResolver).mockReturnValue({ favicon });
    const store = fakeStore(
      stored(
        {
          entries: [
            entry({ id: "xAI:a", registry: "xAI", logo: "https://elsewhere.example/logo.png" }),
            entry({ id: "xAI:b", registry: "xAI", logo: null, domains: ["tasks.example"] }),
            entry({ id: "xAI:c", registry: "xAI", logo: null, domains: ["busy.example"] }),
          ],
        },
        0,
      ),
    );
    const marketplace = createPersistentPluginMarketplace({
      prisma: store.prisma as never,
      imageUrl: (file) => file,
      now: () => T0,
    });
    await marketplace.settled();
    expect(fetchSafeWebText).toHaveBeenCalled();
    expect(fetchSafeWebBytes).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchSafeWebBytes).mock.calls[0]![0]).toBe(
      "https://raw.githubusercontent.com/cursor/plugins/HEAD/notes/logo.png",
    );
    expect(favicon).toHaveBeenCalledWith("https://tasks.example/");
    // Kept from the registry that failed, but not a registry file: recorded as having no image.
    expect(store.images.get("https://elsewhere.example/logo.png")?.hash).toBeNull();
    // A busy lookup is not an answer, so nothing is recorded for it.
    expect(store.images.has("site:https://busy.example/")).toBe(false);
    expect(
      store.images.get("https://raw.githubusercontent.com/cursor/plugins/HEAD/notes/logo.png")
        ?.hash,
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("image sources", () => {
  it("prefers the registry logo, then the first domain, then a homepage off the repository host", () => {
    const base = { logo: null, homepage: null, domains: [] };
    expect(imageSource({ ...base, logo: "https://raw.example/logo.png" })).toBe(
      "https://raw.example/logo.png",
    );
    expect(imageSource({ ...base, domains: ["https://docs.example.com"] })).toBe(
      "site:https://docs.example.com/",
    );
    expect(imageSource({ ...base, homepage: "https://example.com/plugin?x=1" })).toBe(
      "site:https://example.com/",
    );
    expect(imageSource({ ...base, homepage: "https://github.com/owner/repo" })).toBeNull();
    expect(imageSource({ ...base, homepage: "not a url" })).toBeNull();
    expect(imageSource(base)).toBeNull();
  });
});

describe("catalog images", () => {
  it("shrinks a large raster logo to the served size and keeps a small one as it is", async () => {
    const large = await catalogImage(await png(400));
    expect(await sharp(large!).metadata()).toMatchObject({
      format: "webp",
      width: CATALOG_IMAGE_SIZE,
    });
    const small = await catalogImage(await png(32));
    expect((await sharp(small!).metadata()).width).toBe(32);
  });

  it("draws a self-contained SVG to pixels at the served size", async () => {
    const svg = `<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="url(#g)"/><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs></svg>`;
    const out = await catalogImage(new TextEncoder().encode(svg));
    expect(await sharp(out!).metadata()).toMatchObject({
      format: "webp",
      width: CATALOG_IMAGE_SIZE,
    });
  });

  it("refuses SVG that reaches outside itself, non-images and oversized files", async () => {
    const svg = (body: string) =>
      new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">${body}</svg>`,
      );
    expect(await catalogImage(svg('<image href="file:///etc/hostname"/>'))).toBeNull();
    expect(
      await catalogImage(svg('<image xlink:href="https://tracker.example/x.png"/>')),
    ).toBeNull();
    expect(await catalogImage(svg('<rect style="fill:url(https://x.example/a)"/>'))).toBeNull();
    expect(
      await catalogImage(new TextEncoder().encode('<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>')),
    ).toBeNull();
    expect(await catalogImage(new TextEncoder().encode("<html></html>"))).toBeNull();
    const huge = new Uint8Array(600 * 1024);
    huge.set([0x89, 0x50, 0x4e, 0x47]);
    expect(await catalogImage(huge)).toBeNull();
    // Sniffs as PNG but is truncated.
    expect(await catalogImage((await png(64)).subarray(0, 40))).toBeNull();
  });

  it("refuses a PNG over the pixel limit and an SVG too large to draw, and shrinks a large SVG", async () => {
    const wide = await sharp({
      create: { width: 4097, height: 4097, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(wide.length).toBeLessThan(512 * 1024);
    expect(await catalogImage(new Uint8Array(wide))).toBeNull();
    const svg = (side: number) =>
      new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><rect width="${side}" height="${side}"/></svg>`,
      );
    expect(await catalogImage(svg(10_000_000))).toBeNull();
    const large = await catalogImage(svg(5000));
    expect((await sharp(large!).metadata()).width).toBe(CATALOG_IMAGE_SIZE);
  });

  it("refuses SVG that imports a style sheet", async () => {
    const svg = (style: string) =>
      new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><style>${style}</style></svg>`,
      );
    expect(await catalogImage(svg('@import "https://x.example/a.css";'))).toBeNull();
    expect(await catalogImage(svg("@IMPORT 'a.css';"))).toBeNull();
  });

  it("accepts JPEG, GIF and WebP by their bytes", async () => {
    const source = sharp({
      create: { width: 120, height: 60, channels: 3, background: { r: 0, g: 0, b: 255 } },
    });
    for (const format of ["jpeg", "gif", "webp"] as const) {
      const bytes = new Uint8Array(await source.clone().toFormat(format).toBuffer());
      expect(await sharp((await catalogImage(bytes))!).metadata()).toMatchObject({
        width: CATALOG_IMAGE_SIZE,
        height: CATALOG_IMAGE_SIZE / 2,
      });
    }
  });

  it("serves only names that are a content hash", async () => {
    const store = fakeStore();
    const hash = "a".repeat(64);
    store.images.set("x", { source: "x", hash, body: new Uint8Array([1]), checkedAt: new Date() });
    expect(await storedCatalogImage(store.prisma as never, `${hash}.webp`)).toEqual(
      new Uint8Array([1]),
    );
    expect(await storedCatalogImage(store.prisma as never, `${"b".repeat(64)}.webp`)).toBeNull();
    expect(await storedCatalogImage(store.prisma as never, "../secret.webp")).toBeNull();
    expect(store.prisma.dozoCatalogImage.findFirst).toHaveBeenCalledTimes(2);
  });
});
