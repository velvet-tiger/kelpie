-- `idempotency_keys` gets `actor_key`: who sent the request. The row was keyed
-- on the workspace and the header value only, so any member or key of the
-- workspace that sent the same header and body got the stored response of
-- another, and the replay answers before the handler checks a role.
-- The unique constraint now includes the actor.
-- Existing rows keep ''. No caller has that actor key, so a row written before
-- this migration is not replayed and expires within 24 hours. The default
-- stays, so that code from before this migration can still write a row while
-- a deploy is in progress.
-- Hand-written: the drizzle-kit snapshot chain is stale.
ALTER TABLE "idempotency_keys" ADD COLUMN "actor_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_workspace_key_key";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_actor_key_key" UNIQUE("workspace_id","actor_key","key");
