ALTER TABLE "ai_settings" ADD COLUMN "run_log_limit" integer;--> statement-breakpoint
ALTER TABLE "ai_runs" DROP COLUMN "output";--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_run_log_limit_check" CHECK ("ai_settings"."run_log_limit" is null or "ai_settings"."run_log_limit" >= 1);