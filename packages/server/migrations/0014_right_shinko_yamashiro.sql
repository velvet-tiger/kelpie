CREATE TABLE "workspace_module_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"module_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_module_settings_workspace_module_key" UNIQUE("workspace_id","module_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_module_settings" ADD CONSTRAINT "workspace_module_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_module_settings_workspace_idx" ON "workspace_module_settings" USING btree ("workspace_id");