CREATE TABLE "consent_purposes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"default_status" text DEFAULT 'unknown' NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_purposes_workspace_slug_key" UNIQUE("workspace_id","slug"),
	CONSTRAINT "consent_purposes_default_status_check" CHECK ("consent_purposes"."default_status" in ('unknown', 'granted', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "person_consents" (
	"workspace_id" text NOT NULL,
	"person_id" text NOT NULL,
	"purpose_id" text NOT NULL,
	"status" text NOT NULL,
	"noted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_consents_person_id_purpose_id_pk" PRIMARY KEY("person_id","purpose_id"),
	CONSTRAINT "person_consents_status_check" CHECK ("person_consents"."status" in ('granted', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "form_fields" DROP CONSTRAINT "form_fields_type_check";--> statement-breakpoint
ALTER TABLE "form_fields" DROP CONSTRAINT "form_fields_map_to_check";--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "do_not_contact" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "consent_purpose_id" text;--> statement-breakpoint
ALTER TABLE "form_fields" ADD COLUMN "consent_purpose_id" text;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "consent_purpose_id" text;--> statement-breakpoint
ALTER TABLE "consent_purposes" ADD CONSTRAINT "consent_purposes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_consents" ADD CONSTRAINT "person_consents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_consents" ADD CONSTRAINT "person_consents_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_consents" ADD CONSTRAINT "person_consents_purpose_id_consent_purposes_id_fk" FOREIGN KEY ("purpose_id") REFERENCES "public"."consent_purposes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_purposes_workspace_idx" ON "consent_purposes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "person_consents_workspace_idx" ON "person_consents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "person_consents_purpose_idx" ON "person_consents" USING btree ("purpose_id");--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_consent_purpose_id_consent_purposes_id_fk" FOREIGN KEY ("consent_purpose_id") REFERENCES "public"."consent_purposes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_consent_purpose_id_consent_purposes_id_fk" FOREIGN KEY ("consent_purpose_id") REFERENCES "public"."consent_purposes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_consent_purpose_id_consent_purposes_id_fk" FOREIGN KEY ("consent_purpose_id") REFERENCES "public"."consent_purposes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_type_check" CHECK ("form_fields"."type" in ('text', 'email', 'textarea', 'select', 'consent'));--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_map_to_check" CHECK ("form_fields"."map_to" in ('person.name', 'person.first_name', 'person.last_name', 'person.email', 'person.consent', 'company.name', 'company.domain', 'position.title', 'enquiry.name', 'deal.name', 'opportunity.name', 'partnership.name', 'submission'));