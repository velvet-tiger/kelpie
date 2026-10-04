-- `email_verification_tokens` and `password_reset_tokens` get `email`: the
-- address the link was sent to. A token is accepted only while the account
-- still has that address. Before this, a verification token sent to one
-- address verified whichever address the account had moved to, and a reset
-- link in a mailbox the account had left still reset its password.
-- The column is nullable and existing rows keep null. A token with no address
-- is refused, so a link sent before this migration stops working and its
-- owner asks for a new one. Verification links live 24 hours and reset links
-- one hour.
-- Hand-written: the drizzle-kit snapshot chain is stale.
ALTER TABLE "email_verification_tokens" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD COLUMN "email" text;
