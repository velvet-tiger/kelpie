-- `notes` and `decisions` get `origin`: what wrote the row. `member` is a
-- signed-in person, `agent` is a caller with an API key or an OAuth token, and
-- `ai` is a run of the hosted AI. The server sets it from the caller.
-- Existing rows: a note with an author, and a decision with an owner, become
-- `member`. The rest become `agent`. No existing row becomes `ai`, because
-- nothing recorded which rows a run wrote; a run's rows have no author and no
-- owner, so they become `agent`.
-- The default stays, so that code from before this migration can still write a
-- row while a deploy is in progress. Such a row is `agent`. Code from this
-- migration on always sends the value.
-- Hand-written: the drizzle-kit snapshot chain is stale.
ALTER TABLE "notes" ADD COLUMN "origin" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
UPDATE "notes" SET "origin" = 'member' WHERE "author_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_origin_check" CHECK ("notes"."origin" in ('member', 'agent', 'ai'));--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "origin" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
UPDATE "decisions" SET "origin" = 'member' WHERE "owner_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_origin_check" CHECK ("decisions"."origin" in ('member', 'agent', 'ai'));
