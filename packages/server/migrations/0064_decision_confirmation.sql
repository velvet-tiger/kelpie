-- `decisions` gets `confirmed_at` and `confirmed_by_id`. A decision with
-- `confirmed_at` null is a proposal: a hosted AI run wrote it, and no member
-- has confirmed it. A member confirms it with `POST /v1/decisions/:id/confirm`.
-- Every existing row is confirmed at its `created_at`, with no member named,
-- because nothing recorded who looked at it.
-- `confirmed_by_id` is ON DELETE SET NULL. A confirmation cannot be given to
-- another member, so RESTRICT would make that member impossible to remove.
-- `confirmed_at` has no default on purpose: a writer that does not say is a
-- proposal, not a commitment. Code from before this migration does not say, so
-- a decision it writes while a deploy is in progress shows as not confirmed
-- until a member confirms it.
-- Hand-written: the drizzle-kit snapshot chain is stale.
ALTER TABLE "decisions" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "confirmed_by_id" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_confirmed_by_id_workspace_members_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."workspace_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "decisions" SET "confirmed_at" = "created_at";
