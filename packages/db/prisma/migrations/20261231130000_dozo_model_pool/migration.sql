-- Additive: the previous release never reads these tables.
--
-- A model pool is one person's own connections to the same provider that stand in for each other
-- when one runs out of quota or credit, or its key is refused (packages/core/src/dozo-model-pool.ts).
-- Both tables belong to the fork: they have no model in schema.prisma and are read and written with
-- SQL in packages/db/src/dozo-model-pool-store.ts. The composite key to the connection keeps each
-- row on its owner's connection, and both go with it.

-- A connection that is part of its owner's pool for its provider. No row: not pooled.
CREATE TABLE "dozo_model_pool_members" (
  "credentialId" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("credentialId", "userId") REFERENCES "user_model_credentials"("id", "userId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- The last time a pooled connection ran out, and until when it rests. Whether it still rests is
-- read against the clock when a run starts; nothing wakes it. "modelId" is '' when the whole
-- connection rests (a refused key), else the model whose quota ran out. "secretId" is the
-- connection's secret when it ran out: saving a new key gives the connection a new secret, which
-- ends the rest; renaming it does not.
CREATE TABLE "dozo_model_connection_cooldowns" (
  "credentialId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "modelId" TEXT NOT NULL DEFAULT '',
  "secretId" TEXT NOT NULL,
  "reason" TEXT NOT NULL CHECK ("reason" IN ('exhausted', 'rejected')),
  "resetsAt" TIMESTAMPTZ(3) NOT NULL,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("credentialId", "modelId"),
  FOREIGN KEY ("credentialId", "userId") REFERENCES "user_model_credentials"("id", "userId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- The owner's rows only, like user_model_credentials.
ALTER TABLE "dozo_model_pool_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_model_pool_members_tenant ON "dozo_model_pool_members"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_model_pool_members_system ON "dozo_model_pool_members"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "dozo_model_connection_cooldowns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_model_connection_cooldowns_tenant ON "dozo_model_connection_cooldowns"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_model_connection_cooldowns_system ON "dozo_model_connection_cooldowns"
  USING ((SELECT app_rls_bypass()));
