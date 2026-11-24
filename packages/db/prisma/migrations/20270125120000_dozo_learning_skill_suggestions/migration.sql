-- Additive: two columns with no effect on the previous release, which reads neither.

-- The taught skill a review suggested and the owner has not answered yet: a draft card in the
-- bot's chat. While it is still a draft no review suggests another. No link: deleting the skill
-- (the card's Dismiss) is read by the code that deletes it, which turns the suggestion down.
ALTER TABLE "dozo_bot_learning" ADD COLUMN "suggestedSkillId" TEXT;

-- What a turned-down line was: a note ('note'), or the name of a suggested skill the owner
-- dismissed ('skill'), which no review suggests again. The previous release reads every row as a
-- note, which only keeps it from writing a note that reads as a skill's name.
ALTER TABLE "dozo_learning_rejections" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'note'
  CHECK ("kind" IN ('note', 'skill'));
