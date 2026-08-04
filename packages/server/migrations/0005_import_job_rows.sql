CREATE TABLE "import_job_rows" (
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action" text NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_job_rows_job_id_row_number_pk" PRIMARY KEY("job_id","row_number"),
	CONSTRAINT "import_job_rows_action_check" CHECK ("import_job_rows"."action" in ('pending', 'create', 'update', 'skip', 'error'))
);
--> statement-breakpoint
ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_object_check";--> statement-breakpoint
ALTER TABLE "import_jobs" ALTER COLUMN "counts" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "source_headers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "import_job_rows" ADD CONSTRAINT "import_job_rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job_rows" ADD CONSTRAINT "import_job_rows_job_id_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_job_rows_workspace_idx" ON "import_job_rows" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_status_check" CHECK ("import_jobs"."status" in ('pending', 'validating', 'ready', 'committing', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_object_check" CHECK ("import_jobs"."object" in ('companies', 'people', 'positions', 'deals'));