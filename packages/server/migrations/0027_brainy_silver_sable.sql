ALTER TABLE "forms" ADD COLUMN "title" text;--> statement-breakpoint
UPDATE "forms" SET "title" = "name" WHERE "title" IS NULL;--> statement-breakpoint
ALTER TABLE "forms" ALTER COLUMN "title" SET NOT NULL;
