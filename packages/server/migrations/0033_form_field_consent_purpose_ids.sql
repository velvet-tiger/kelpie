ALTER TABLE "form_fields" DROP CONSTRAINT "form_fields_consent_purpose_id_consent_purposes_id_fk";
--> statement-breakpoint
ALTER TABLE "form_fields" ADD COLUMN "consent_purpose_ids" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
UPDATE "form_fields" SET "consent_purpose_ids" = ARRAY["consent_purpose_id"] WHERE "consent_purpose_id" IS NOT NULL;
