-- Additive: the previous release never reads the new column.
--
-- The pictures around the clicks recorded while teaching follow the typed values: from the moment
-- a recording becomes a draft they live sealed in dozo_teach_values beside the values, readable
-- only by the teacher and deleted with the save, with the skill, or when due
-- (packages/db/src/dozo-teach-values.ts). The recording keeps each click's window only.
ALTER TABLE "dozo_teach_values" ADD COLUMN "targets" TEXT;

-- Recordings drafted or saved before this kept the pictures, and the model's labels, in their
-- recording; their click positions were also counted before typed runs were collapsed. They are
-- dropped: those clicks keep their coordinate only.
UPDATE "taught_skills"
SET "recording" = "recording" - 'dozoTargets' - 'dozoLabels'
WHERE "status" IN ('saved', 'draft', 'drafting')
  AND jsonb_typeof("recording") = 'object'
  AND ("recording" ? 'dozoTargets' OR "recording" ? 'dozoLabels');
