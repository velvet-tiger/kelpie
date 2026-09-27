-- A form's public handle becomes its slug. Public URLs now name the workspace
-- by id, so the slug is unique in its workspace only, and a user can choose it.
-- Existing values are random base64url tokens; they already match the slug
-- format, so they stay as they are.
ALTER TABLE "forms" RENAME COLUMN "public_key" TO "slug";--> statement-breakpoint
ALTER TABLE "forms" DROP CONSTRAINT "forms_public_key_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "forms_workspace_slug_idx" ON "forms" USING btree ("workspace_id","slug");
