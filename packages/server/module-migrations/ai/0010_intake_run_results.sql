ALTER TABLE "ai_runs" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "result_expires_at" timestamp with time zone;