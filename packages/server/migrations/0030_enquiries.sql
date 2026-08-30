CREATE TABLE "enquiries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"stage_id" text NOT NULL,
	"company_id" text,
	"owner_id" text,
	"converted_deal_id" text,
	"summary" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', regexp_replace(coalesce("enquiries"."name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("enquiries"."source"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce("enquiries"."summary"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce(kelpie_text_array_to_string("enquiries"."tags"), ''), '[^[:alnum:]]+', ' ', 'g')), 'C')) STORED
);
--> statement-breakpoint
ALTER TABLE "person_links" DROP CONSTRAINT "person_links_target_type_check";--> statement-breakpoint
ALTER TABLE "pipeline_stages" DROP CONSTRAINT "pipeline_stages_kind_check";--> statement-breakpoint
ALTER TABLE "plan_items" DROP CONSTRAINT "plan_items_target_type_check";--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_target_type_check";--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_target_type_check";--> statement-breakpoint
ALTER TABLE "list_members" DROP CONSTRAINT "list_members_target_type_check";--> statement-breakpoint
ALTER TABLE "lists" DROP CONSTRAINT "lists_target_type_check";--> statement-breakpoint
ALTER TABLE "activities" DROP CONSTRAINT "activities_target_type_check";--> statement-breakpoint
ALTER TABLE "custom_field_definitions" DROP CONSTRAINT "custom_field_definitions_object_type_check";--> statement-breakpoint
ALTER TABLE "form_attach_targets" DROP CONSTRAINT "form_attach_targets_target_type_check";--> statement-breakpoint
ALTER TABLE "form_fields" DROP CONSTRAINT "form_fields_map_to_check";--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "enquiry_id" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "create_enquiry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "enquiry_source" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "enquiry_stage_id" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "enquiry_name_template" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "enquiry_owner_id" text;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_owner_id_workspace_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."workspace_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_converted_deal_id_deals_id_fk" FOREIGN KEY ("converted_deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enquiries_workspace_idx" ON "enquiries" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "enquiries_stage_idx" ON "enquiries" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "enquiries_converted_deal_idx" ON "enquiries" USING btree ("converted_deal_id");--> statement-breakpoint
CREATE INDEX "enquiries_search_idx" ON "enquiries" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_enquiry_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("enquiry_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_enquiry_owner_id_workspace_members_id_fk" FOREIGN KEY ("enquiry_owner_id") REFERENCES "public"."workspace_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_links" ADD CONSTRAINT "person_links_target_type_check" CHECK ("person_links"."target_type" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership'));--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_kind_check" CHECK ("pipeline_stages"."kind" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership'));--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_target_type_check" CHECK ("plan_items"."target_type" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership'));--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_target_type_check" CHECK ("decisions"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate'));--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_target_type_check" CHECK ("notes"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate'));--> statement-breakpoint
ALTER TABLE "list_members" ADD CONSTRAINT "list_members_target_type_check" CHECK ("list_members"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate'));--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_target_type_check" CHECK ("lists"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate'));--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_target_type_check" CHECK ("activities"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate'));--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_object_type_check" CHECK ("custom_field_definitions"."object_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry'));--> statement-breakpoint
ALTER TABLE "form_attach_targets" ADD CONSTRAINT "form_attach_targets_target_type_check" CHECK ("form_attach_targets"."target_type" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership'));--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_map_to_check" CHECK ("form_fields"."map_to" in ('person.name', 'person.first_name', 'person.last_name', 'person.email', 'company.name', 'company.domain', 'position.title', 'enquiry.name', 'deal.name', 'opportunity.name', 'partnership.name', 'submission'));--> statement-breakpoint
-- Backfill: seed the three starter enquiry stages for every existing workspace.
-- Precedent: migration 0024 hand-inserts polymorphic rows with gen_random_uuid()
-- ids and ON CONFLICT DO NOTHING. Starter stages otherwise only seed at workspace
-- creation, so without this every existing workspace would 409 on the first
-- enquiry create and render zero kanban columns. Re-running the migration is a
-- no-op thanks to the unique (workspace_id, kind, slug) key.
INSERT INTO "pipeline_stages" ("id", "workspace_id", "kind", "slug", "label", "open", "sort_order")
SELECT
  'stage_' || replace(gen_random_uuid()::text, '-', ''),
  w."id",
  'enquiry',
  s.slug,
  s.label,
  s.open,
  s.sort_order
FROM "workspaces" w
CROSS JOIN (VALUES
  ('new', 'New', true, 0),
  ('in_progress', 'In progress', true, 1),
  ('closed', 'Closed', false, 2)
) AS s(slug, label, open, sort_order)
ON CONFLICT ("workspace_id", "kind", "slug") DO NOTHING;