-- Additive: the previous release never reads these tables. The plugin catalog last read from the
-- public registries, and the logos and site icons drawn for it, so a restart serves both at once.
-- No row-level policy: they hold public catalog data only, shared by every tenant, and no
-- tenant-facing route writes them.
CREATE TABLE "dozo_catalog_snapshots" (
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dozo_catalog_snapshots_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "dozo_catalog_images" (
    "source" TEXT NOT NULL,
    "hash" TEXT,
    "body" BYTEA,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dozo_catalog_images_pkey" PRIMARY KEY ("source")
);

CREATE INDEX "dozo_catalog_images_hash_idx" ON "dozo_catalog_images"("hash");
