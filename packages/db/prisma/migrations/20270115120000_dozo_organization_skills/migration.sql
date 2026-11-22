-- Additive: the previous release never reads this table or the new policies. An organization's
-- skill library: a row puts one of its owner's own skills in it, so every member of the
-- organization's Spaces reads that skill (its text and files only) and their bots use it. The skill
-- stays the owner's agent_skills row; only the owner changes it. Deleting the skill or the
-- organization takes the row with it. The model is DozoOrganizationSkill (a brand rule).
CREATE TABLE "dozo_organization_skills" (
    "skillId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sharedById" TEXT,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dozo_organization_skills_pkey" PRIMARY KEY ("skillId")
);

CREATE INDEX "dozo_organization_skills_organizationId_idx" ON "dozo_organization_skills"("organizationId");

ALTER TABLE "dozo_organization_skills" ADD CONSTRAINT "dozo_organization_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "agent_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dozo_organization_skills" ADD CONSTRAINT "dozo_organization_skills_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dozo_organization_skills" ADD CONSTRAINT "dozo_organization_skills_sharedById_fkey" FOREIGN KEY ("sharedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A row is seen by a member of a Space of its organization, from that Space: membership is read on
-- every statement, so someone who leaves the Space stops reaching the library at once.
ALTER TABLE "dozo_organization_skills" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_organization_skills_tenant ON "dozo_organization_skills"
  USING (EXISTS (
    SELECT 1 FROM "spaces" s
    JOIN "space_members" m ON m."spaceId" = s."id"
    WHERE s."organizationId" = "dozo_organization_skills"."organizationId"
      AND s."id" = NULLIF(current_setting('app.space_id', true), '')
      AND s."deletingAt" IS NULL
      AND m."userId" = NULLIF(current_setting('app.user_id', true), '')
  ));
CREATE POLICY dozo_organization_skills_system ON "dozo_organization_skills"
  USING ((SELECT app_rls_bypass()));

-- Permissive, beside the owner's own policies on agent_skills: a member also reads a skill of the
-- library of the organization their open Space belongs to, and only a skill its owner wrote
-- (a plugin's skill comes with the owner's install, so it never goes in). Reading only: writes
-- keep the owner's policies, which name the owner.
CREATE POLICY agent_skills_dozo_organization ON "agent_skills"
  FOR SELECT
  USING (
    "source" = 'user'
    AND EXISTS (
      SELECT 1 FROM "dozo_organization_skills" l
      WHERE l."skillId" = "agent_skills"."id"
    )
  );
