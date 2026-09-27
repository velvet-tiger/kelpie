ALTER TABLE "ai_runs" ALTER COLUMN "prompt" DROP NOT NULL;--> statement-breakpoint
-- Settled and failed runs keep metadata only. Clear the text already stored.
UPDATE "ai_runs" SET "prompt" = NULL, "context" = NULL WHERE "status" IN ('succeeded', 'failed');