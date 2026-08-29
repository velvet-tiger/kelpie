CREATE TABLE "form_attach_targets" (
	"workspace_id" text NOT NULL,
	"form_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	CONSTRAINT "form_attach_targets_form_id_target_type_target_id_pk" PRIMARY KEY("form_id","target_type","target_id"),
	CONSTRAINT "form_attach_targets_target_type_check" CHECK ("form_attach_targets"."target_type" in ('deal', 'opportunity', 'raise', 'partnership'))
);
--> statement-breakpoint
CREATE TABLE "form_lists" (
	"workspace_id" text NOT NULL,
	"form_id" text NOT NULL,
	"list_id" text NOT NULL,
	CONSTRAINT "form_lists_form_id_list_id_pk" PRIMARY KEY("form_id","list_id")
);
--> statement-breakpoint
ALTER TABLE "form_fields" DROP CONSTRAINT "form_fields_map_to_check";--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "opportunity_id" text;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "partnership_id" text;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "action_log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "create_opportunity" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "opportunity_kind" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "opportunity_stage_id" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "opportunity_name_template" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "opportunity_owner_id" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "create_partnership" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "partnership_kind" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "partnership_stage_id" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "partnership_name_template" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "partnership_owner_id" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "person_tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "company_tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "form_attach_targets" ADD CONSTRAINT "form_attach_targets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_attach_targets" ADD CONSTRAINT "form_attach_targets_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_lists" ADD CONSTRAINT "form_lists_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_lists" ADD CONSTRAINT "form_lists_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_lists" ADD CONSTRAINT "form_lists_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_attach_targets_target_idx" ON "form_attach_targets" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "form_lists_workspace_idx" ON "form_lists" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_partnership_id_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."partnerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_opportunity_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("opportunity_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_opportunity_owner_id_workspace_members_id_fk" FOREIGN KEY ("opportunity_owner_id") REFERENCES "public"."workspace_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_partnership_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("partnership_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_partnership_owner_id_workspace_members_id_fk" FOREIGN KEY ("partnership_owner_id") REFERENCES "public"."workspace_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_map_to_check" CHECK ("form_fields"."map_to" in ('person.name', 'person.email', 'company.name', 'company.domain', 'position.title', 'deal.name', 'opportunity.name', 'partnership.name', 'submission'));