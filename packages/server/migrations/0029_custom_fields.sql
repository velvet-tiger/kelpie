CREATE TABLE "custom_field_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"object_type" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_definitions_workspace_object_key_key" UNIQUE("workspace_id","object_type","key"),
	CONSTRAINT "custom_field_definitions_object_type_check" CHECK ("custom_field_definitions"."object_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise')),
	CONSTRAINT "custom_field_definitions_type_check" CHECK ("custom_field_definitions"."type" in ('text', 'long_text', 'number', 'currency', 'date', 'checkbox', 'select', 'multi_select', 'url'))
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "partnerships" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "raises" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_field_definitions_workspace_idx" ON "custom_field_definitions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "custom_field_definitions_workspace_object_idx" ON "custom_field_definitions" USING btree ("workspace_id","object_type");