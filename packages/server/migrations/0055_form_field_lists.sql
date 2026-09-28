-- An "Add to list" form field: one checkbox per list, each with an optional
-- label override. `list` joins the field types the check constraint allows.
ALTER TABLE "form_fields" ADD COLUMN "list_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "form_fields" ADD COLUMN "list_labels" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "form_fields" DROP CONSTRAINT "form_fields_type_check";--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_type_check" CHECK ("form_fields"."type" in ('text', 'email', 'textarea', 'select', 'consent', 'notice', 'list'));
