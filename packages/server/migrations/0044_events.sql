CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"meeting_url" text,
	"format" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"owner_id" text,
	"summary" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', regexp_replace(coalesce("events"."name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("events"."details"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce("events"."summary"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce("events"."kind"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'C') || setweight(to_tsvector('english', regexp_replace(coalesce("events"."location"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'C') || setweight(to_tsvector('english', regexp_replace(coalesce(kelpie_text_array_to_string("events"."tags"), ''), '[^[:alnum:]]+', ' ', 'g')), 'C')) STORED
);
--> statement-breakpoint
CREATE TABLE "attendances" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"event_id" text NOT NULL,
	"person_id" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_associations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"event_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_target_type_check";--> statement-breakpoint
ALTER TABLE "activities" DROP CONSTRAINT "activities_target_type_check";--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_target_type_check";--> statement-breakpoint
ALTER TABLE "lists" DROP CONSTRAINT "lists_target_type_check";--> statement-breakpoint
ALTER TABLE "list_members" DROP CONSTRAINT "list_members_target_type_check";--> statement-breakpoint
ALTER TABLE "plan_items" DROP CONSTRAINT "plan_items_target_type_check";--> statement-breakpoint
ALTER TABLE "form_attach_targets" DROP CONSTRAINT "form_attach_targets_target_type_check";--> statement-breakpoint
ALTER TABLE "custom_field_definitions" DROP CONSTRAINT "custom_field_definitions_object_type_check";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_workspace_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."workspace_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_format_check" CHECK ("events"."format" in ('in_person', 'virtual', 'hybrid'));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_status_check" CHECK ("events"."status" in ('draft', 'scheduled', 'cancelled'));--> statement-breakpoint
CREATE INDEX "events_workspace_idx" ON "events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "events_starts_idx" ON "events" USING btree ("workspace_id","starts_at");--> statement-breakpoint
CREATE INDEX "events_search_idx" ON "events" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_event_person_key" UNIQUE ("event_id","person_id");--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_status_check" CHECK ("attendances"."status" in ('registered', 'attended', 'no_show', 'cancelled'));--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_source_check" CHECK ("attendances"."source" in ('manual', 'form'));--> statement-breakpoint
CREATE INDEX "attendances_workspace_idx" ON "attendances" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "attendances_event_idx" ON "attendances" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "attendances_person_idx" ON "attendances" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "event_associations" ADD CONSTRAINT "event_associations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_associations" ADD CONSTRAINT "event_associations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_associations" ADD CONSTRAINT "event_associations_event_target_key" UNIQUE ("event_id","target_type","target_id");--> statement-breakpoint
ALTER TABLE "event_associations" ADD CONSTRAINT "event_associations_target_type_check" CHECK ("event_associations"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'role', 'candidate'));--> statement-breakpoint
CREATE INDEX "event_associations_target_idx" ON "event_associations" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_target_type_check" CHECK ("notes"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate', 'event', 'attendance'));--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_target_type_check" CHECK ("activities"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate', 'event', 'attendance'));--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_target_type_check" CHECK ("decisions"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate', 'event', 'attendance'));--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_target_type_check" CHECK ("lists"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate', 'event', 'attendance'));--> statement-breakpoint
ALTER TABLE "list_members" ADD CONSTRAINT "list_members_target_type_check" CHECK ("list_members"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'candidate', 'event', 'attendance'));--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_target_type_check" CHECK ("plan_items"."target_type" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership', 'event'));--> statement-breakpoint
ALTER TABLE "form_attach_targets" ADD CONSTRAINT "form_attach_targets_target_type_check" CHECK ("form_attach_targets"."target_type" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership', 'event'));--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_object_type_check" CHECK ("custom_field_definitions"."object_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'enquiry', 'event'));
