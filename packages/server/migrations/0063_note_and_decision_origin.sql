-- `notes` and `decisions` get `origin`: what wrote the row. `member` is a
-- signed-in person, `agent` is a caller with an API key or an OAuth token, and
-- `ai` is a run of the hosted AI. The server sets it from the caller.
-- A fourth value, `unknown`, is for rows from before this migration. Every
-- existing row gets it. An author or an owner does not show that a person
-- wrote the row: a personal API key and an OAuth grant carry a member too, and
-- nothing recorded which rows a run wrote.
-- The column default is `unknown`, and it does the backfill: no UPDATE runs.
-- The default stays, so that code from before this migration can still write a
-- row while a deploy is in progress. Such a row is `unknown`, which is true:
-- that code did not say. Code from this migration on always sends the value.
-- Hand-written: the drizzle-kit snapshot chain is stale.
ALTER TABLE "notes" ADD COLUMN "origin" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_origin_check" CHECK ("notes"."origin" in ('member', 'agent', 'ai', 'unknown'));--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "origin" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_origin_check" CHECK ("decisions"."origin" in ('member', 'agent', 'ai', 'unknown'));
