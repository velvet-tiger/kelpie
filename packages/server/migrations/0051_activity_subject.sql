-- The record an activity row is about, when that is not the record it is filed
-- on: the note that was added, the company a person was linked to, the form a
-- deal came in through. The timeline links it.
ALTER TABLE "activities" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_subject_type_check" CHECK ("activities"."subject_type" is null or "activities"."subject_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate', 'event', 'attendance', 'role', 'handbook_page', 'list', 'form', 'note', 'decision', 'plan_item'));--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_subject_pair_check" CHECK (("activities"."subject_type" is null) = ("activities"."subject_id" is null));--> statement-breakpoint
-- Hand-added. Rows written before this migration say "added a note" and name no
-- note. Match each to its note only where the match is certain: a note on the
-- same record, created within five seconds of the row, where that row matches
-- exactly one note and that note matches exactly one row. Anything else stays
-- unlinked rather than risk pointing at the wrong note.
WITH "pairs" AS (
  SELECT "a"."id" AS "activity_id", "n"."id" AS "note_id"
  FROM "activities" "a"
  JOIN "notes" "n"
    ON "n"."workspace_id" = "a"."workspace_id"
    AND "n"."target_type" = "a"."target_type"
    AND "n"."target_id" = "a"."target_id"
    AND abs(extract(epoch FROM ("n"."created_at" - "a"."created_at"))) <= 5
  WHERE "a"."kind" = 'note_added' AND "a"."subject_id" IS NULL
),
"certain" AS (
  SELECT "activity_id", "note_id" FROM "pairs"
  WHERE "activity_id" IN (SELECT "activity_id" FROM "pairs" GROUP BY "activity_id" HAVING count(*) = 1)
    AND "note_id" IN (SELECT "note_id" FROM "pairs" GROUP BY "note_id" HAVING count(*) = 1)
)
UPDATE "activities"
SET "subject_type" = 'note', "subject_id" = "certain"."note_id"
FROM "certain"
WHERE "activities"."id" = "certain"."activity_id";
