-- Spam protection for public form submits. A form can require the spam check,
-- and a submission the check catches is stored as `spam` with a reason rather
-- than refused. Existing forms keep `require_spam_check` off, so a site that
-- posts JSON from its own form is not put in quarantine by an upgrade.
-- Hand-written: the drizzle-kit snapshot chain is stale.
ALTER TABLE "forms" ADD COLUMN "require_spam_check" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "status" text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "spam_reason" text;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_status_check" CHECK ("form_submissions"."status" in ('accepted', 'spam'));--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_spam_reason_check" CHECK ("form_submissions"."spam_reason" is null or "form_submissions"."spam_reason" in ('honeypot', 'token_missing', 'token_invalid', 'token_expired', 'too_fast', 'captcha_missing', 'captcha_failed'));--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_spam_has_reason_check" CHECK ("form_submissions"."status" <> 'spam' or "form_submissions"."spam_reason" is not null);
