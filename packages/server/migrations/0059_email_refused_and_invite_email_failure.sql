-- Two records of an email that did not arrive.
-- `form_email_sends.status` gets a fourth value, `refused`: the mail system
-- refused the message for good, and the form email job does not send it
-- again. Until now such a message was an `error` like one a retry can clear.
-- `invites` gets `email_failed_at` and `email_failure`: when the invitation
-- email failed for the last time, and why. Both are null while no failure is
-- recorded, and a later successful send or a resend sets them back to null.
-- `invites` also gets `email_request`, the number of the newest request to
-- send the invitation email: 0 when the invitation is made, and one more for
-- each resend. The email job carries the number of its own request and does
-- nothing when the invitation holds a different one.
-- Hand-written: the drizzle-kit snapshot chain is stale.
ALTER TABLE "form_email_sends" DROP CONSTRAINT "form_email_sends_status_check";--> statement-breakpoint
ALTER TABLE "form_email_sends" ADD CONSTRAINT "form_email_sends_status_check" CHECK ("form_email_sends"."status" in ('sent', 'skipped', 'error', 'refused'));--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "email_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "email_failure" text;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_email_failure_check" CHECK (("invites"."email_failed_at" is null) = ("invites"."email_failure" is null));--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "email_request" integer DEFAULT 0 NOT NULL;
