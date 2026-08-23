ALTER TABLE "import_job_rows" ADD COLUMN "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "on_missing_company" text DEFAULT 'skip' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_on_missing_company_check" CHECK ("import_jobs"."on_missing_company" in ('skip', 'create'));