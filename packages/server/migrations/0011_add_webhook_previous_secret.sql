ALTER TABLE "webhooks" ADD COLUMN "previous_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "previous_secret_expires_at" timestamp with time zone;