-- Additive for the previous release, which never reads these tables or policies. It replaces the
-- two policies of 20270115120000_dozo_organization_skills, which no release has shipped, so a
-- library skill is read only while the person who shared it still owns the organization (the
-- library row names them; a deleted account leaves it null and the skill unread). It adds the
-- per-member switch that keeps a library skill out of that member's own bots.

-- The organization owner role, as isOwnerRole (packages/db/src/billing.ts) reads it: the auth
-- library stores a comma list, and only a whole entry "owner" counts.
CREATE FUNCTION dozo_is_owner_role(role TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT EXISTS (
    SELECT 1 FROM unnest(string_to_array(role, ',')) AS entry
    WHERE btrim(entry, E' \t\n\r') = 'owner'
  ) $$;

DROP POLICY dozo_organization_skills_tenant ON "dozo_organization_skills";
CREATE POLICY dozo_organization_skills_tenant ON "dozo_organization_skills"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "spaces" s
      JOIN "space_members" m ON m."spaceId" = s."id"
      WHERE s."organizationId" = "dozo_organization_skills"."organizationId"
        AND s."id" = NULLIF(current_setting('app.space_id', true), '')
        AND s."deletingAt" IS NULL
        AND m."userId" = NULLIF(current_setting('app.user_id', true), '')
    )
    AND EXISTS (
      SELECT 1 FROM "member" o
      WHERE o."organizationId" = "dozo_organization_skills"."organizationId"
        AND o."userId" = "dozo_organization_skills"."sharedById"
        AND dozo_is_owner_role(o."role")
    )
  );

-- The skill must still be the sharer's own: the row and the skill name the same person.
DROP POLICY agent_skills_dozo_organization ON "agent_skills";
CREATE POLICY agent_skills_dozo_organization ON "agent_skills"
  FOR SELECT
  USING (
    "source" = 'user'
    AND EXISTS (
      SELECT 1 FROM "dozo_organization_skills" l
      WHERE l."skillId" = "agent_skills"."id"
        AND l."sharedById" = "agent_skills"."userId"
    )
  );

-- A member who turned a library skill off for themselves: their bots no longer use it. It stays
-- listed for them as off, to turn back on. Leaving takes nothing here with it: the library read
-- already ends with the membership.
CREATE TABLE "dozo_organization_skill_hides" (
    "skillId" TEXT NOT NULL REFERENCES "agent_skills"("id") ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dozo_organization_skill_hides_pkey" PRIMARY KEY ("skillId", "userId")
);
CREATE INDEX "dozo_organization_skill_hides_userId_idx" ON "dozo_organization_skill_hides"("userId");

ALTER TABLE "dozo_organization_skill_hides" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_organization_skill_hides_tenant ON "dozo_organization_skill_hides"
  FOR SELECT
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_organization_skill_hides_system ON "dozo_organization_skill_hides"
  USING ((SELECT app_rls_bypass()));
