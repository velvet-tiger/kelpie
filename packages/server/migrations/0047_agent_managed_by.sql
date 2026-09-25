-- A module that owns an agent registration (the cloud's hosted AI, say) marks
-- the row so the API refuses changes to it and the UI points at the module's
-- own settings page. Rows an admin registers keep both columns null.
ALTER TABLE "agent_registrations" ADD COLUMN "managed_by" text;
--> statement-breakpoint
ALTER TABLE "agent_registrations" ADD COLUMN "settings_path" text;
--> statement-breakpoint
ALTER TABLE "agent_registrations" ADD CONSTRAINT "agent_registrations_settings_path_managed" CHECK ("settings_path" IS NULL OR "managed_by" IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_registrations_managed_by_idx" ON "agent_registrations" USING btree ("workspace_id","managed_by") WHERE "managed_by" IS NOT NULL;
