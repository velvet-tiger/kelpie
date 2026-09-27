-- A consent purpose gets the sentence a form shows beside its checkbox. The
-- label stays the short name a Person record shows. `{{workspace}}` is kept
-- as written and expanded to the workspace name when a form renders.
ALTER TABLE "consent_purposes" ADD COLUMN "statement" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "consent_purposes"
SET "statement" = 'I consent to {{workspace}} contacting me and retaining my information for the purpose of handling my enquiry.'
WHERE "slug" = 'contact' AND "statement" = '';--> statement-breakpoint
UPDATE "consent_purposes"
SET "statement" = 'I consent to {{workspace}} retaining my information for marketing purposes.'
WHERE "slug" = 'marketing' AND "statement" = '';
