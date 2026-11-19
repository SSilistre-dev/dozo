-- Additive: the previous release never reads the new table, and nothing it runs reads the typed
-- keys of a recording that is no longer recording. A migration of its own: the one before it
-- (20261230120000) is already applied on databases, which never run an edited migration again.
--
-- What was typed while teaching is kept for the teacher's review only: from the moment a
-- recording becomes a draft, its values live here for 24 hours, sealed with the Space's content
-- key, and the recording keeps none of them. Deleted with the save, with the skill, or when due
-- (packages/db/src/dozo-teach-values.ts). The table belongs to the fork and, like
-- dozo_member_firsts, has no model in schema.prisma: it is read and written with SQL.
CREATE TABLE "dozo_teach_values" (
  "skillId" TEXT NOT NULL PRIMARY KEY REFERENCES "taught_skills"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL,
  -- The person who taught the skill: the only one the values are shown to.
  "userId" TEXT NOT NULL,
  -- The values as JSON text, sealed like other user content.
  "values" TEXT NOT NULL,
  -- The model's suggested names, once asked; it never saw the values.
  "suggestions" JSONB,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Tenant data, scoped like taught_skills; only the teacher's own routes read it.
ALTER TABLE "dozo_teach_values" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_teach_values_tenant ON "dozo_teach_values"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_teach_values_system ON "dozo_teach_values"
  USING ((SELECT app_rls_bypass()));

-- Saved and drafted skills forget what was typed, as every draft does from now on: each typed
-- run (keys, pastes and the edits among them, between any other events) becomes one
-- {"at", "kind": "key", "typed": true} event, so neither its text, its length nor its timing is
-- left. Tab, Enter and the other keys stay: they are steps. A run of edits alone holds no text and
-- stays. Cached value suggestions go too. Playbooks are left alone: the teacher saw those steps.
-- The values of these older drafts are not kept anywhere: their review shows none.
WITH ev AS (
  SELECT s."id", t.e, t.ord,
    jsonb_typeof(t.e) = 'object' AND (t.e->>'kind' = 'clipboard' OR (t.e->>'kind' = 'key' AND (
      char_length(COALESCE(t.e->>'key', '')) <= 1
      OR t.e->>'key' IN ('Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
        'Home', 'End')))) AS member,
    jsonb_typeof(t.e) = 'object' AND (t.e->>'kind' = 'clipboard'
      OR (t.e->>'kind' = 'key' AND char_length(COALESCE(t.e->>'key', '')) <= 1)) AS typed
  FROM "taught_skills" s
  CROSS JOIN LATERAL jsonb_array_elements(s."recording"->'events') WITH ORDINALITY AS t(e, ord)
  WHERE s."status" IN ('saved', 'draft', 'drafting')
    AND jsonb_typeof(s."recording"->'events') = 'array'
),
grouped AS (
  SELECT ev.*, sum(CASE WHEN member THEN 0 ELSE 1 END) OVER (PARTITION BY "id" ORDER BY ord) AS grp
  FROM ev
),
runs AS (
  SELECT "id", grp FROM grouped WHERE member GROUP BY "id", grp HAVING bool_or(typed)
),
collapsed AS (
  SELECT g."id", g.ord, g.e FROM grouped g
  WHERE NOT g.member OR NOT EXISTS (SELECT 1 FROM runs r WHERE r."id" = g."id" AND r.grp = g.grp)
  UNION ALL
  SELECT g."id", min(g.ord), jsonb_strip_nulls(jsonb_build_object(
    'at', (array_agg(g.e->'at' ORDER BY g.ord))[1],
    'kind', 'key',
    'typed', true,
    'sensitive', CASE WHEN bool_or(g.e->'sensitive' = 'true'::jsonb) THEN true END))
  FROM grouped g JOIN runs r ON r."id" = g."id" AND r.grp = g.grp
  WHERE g.member
  GROUP BY g."id", g.grp
)
UPDATE "taught_skills" s SET "recording" = jsonb_set(
  s."recording" - 'dozoSuggestions',
  '{events}',
  (SELECT COALESCE(jsonb_agg(c.e ORDER BY c.ord), '[]'::jsonb) FROM collapsed c WHERE c."id" = s."id")
)
WHERE s."status" IN ('saved', 'draft', 'drafting')
  AND jsonb_typeof(s."recording"->'events') = 'array';
