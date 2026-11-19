-- Additive: nothing reads a saved skill's recording, so the previous release works with it. A saved
-- skill forgets what was typed while teaching: the keys and text of its key and clipboard events
-- (and any cached value suggestions) go, as every save does from now on
-- (apps/api/src/dozo-taught-skills.ts). Playbooks are left alone: the teacher saw those steps.
UPDATE "taught_skills" SET "recording" = jsonb_set(
  "recording" - 'dozoSuggestions',
  '{events}',
  (SELECT coalesce(jsonb_agg(
      CASE WHEN jsonb_typeof(e) = 'object' AND e->>'kind' IN ('key', 'clipboard')
        THEN e - 'key' - 'text' ELSE e END ORDER BY ord), '[]'::jsonb)
    FROM jsonb_array_elements("recording"->'events') WITH ORDINALITY AS t(e, ord))
)
WHERE "status" = 'saved' AND jsonb_typeof("recording"->'events') = 'array';
