CREATE TABLE "list_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"list_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "list_members_list_target_key" UNIQUE("list_id","target_id"),
	CONSTRAINT "list_members_target_type_check" CHECK ("list_members"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'candidate'))
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lists_workspace_name_key" UNIQUE("workspace_id","name"),
	CONSTRAINT "lists_id_target_type_key" UNIQUE("id","target_type"),
	CONSTRAINT "lists_target_type_check" CHECK ("lists"."target_type" in ('person', 'company', 'deal', 'opportunity', 'partnership', 'raise', 'candidate'))
);
--> statement-breakpoint
ALTER TABLE "list_members" ADD CONSTRAINT "list_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_members" ADD CONSTRAINT "list_members_list_target_type_fk" FOREIGN KEY ("list_id","target_type") REFERENCES "public"."lists"("id","target_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "list_members_list_idx" ON "list_members" USING btree ("workspace_id","list_id");--> statement-breakpoint
CREATE INDEX "list_members_target_idx" ON "list_members" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "lists_workspace_idx" ON "lists" USING btree ("workspace_id");