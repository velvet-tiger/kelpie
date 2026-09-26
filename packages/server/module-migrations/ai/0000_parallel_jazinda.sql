CREATE TABLE "ai_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"output" text,
	"failure_reason" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_runs_status_check" CHECK ("ai_runs"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"dispatch_secret_encrypted" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_agent_run_id_key" ON "ai_runs" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "ai_runs_workspace_idx" ON "ai_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ai_runs_workspace_status_idx" ON "ai_runs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "ai_runs_workspace_created_idx" ON "ai_runs" USING btree ("workspace_id","created_at");