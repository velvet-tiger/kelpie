CREATE TABLE "person_links" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"person_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	CONSTRAINT "person_links_person_target_key" UNIQUE("person_id","target_type","target_id"),
	CONSTRAINT "person_links_target_type_check" CHECK ("person_links"."target_type" in ('deal', 'opportunity', 'raise', 'partnership'))
);
--> statement-breakpoint
ALTER TABLE "person_links" ADD CONSTRAINT "person_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_links" ADD CONSTRAINT "person_links_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_links_target_idx" ON "person_links" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
-- Backfill from the three per-pipeline join tables, hand-added because drizzle-kit
-- writes DDL only and this table replaces them. `workspace_id` comes from the
-- parent join (the old joins never carried one). `ON CONFLICT DO NOTHING` makes
-- each statement re-run-safe even though the journal only applies it once.
-- The join tables themselves are dropped by the next migration, after the
-- service code has stopped writing to them.
INSERT INTO "person_links" ("id", "workspace_id", "person_id", "target_type", "target_id")
SELECT 'plink_' || replace(gen_random_uuid()::text, '-', ''),
       "deals"."workspace_id",
       "deal_people"."person_id",
       'deal',
       "deal_people"."deal_id"
FROM "deal_people"
JOIN "deals" ON "deals"."id" = "deal_people"."deal_id"
ON CONFLICT ("person_id", "target_type", "target_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "person_links" ("id", "workspace_id", "person_id", "target_type", "target_id")
SELECT 'plink_' || replace(gen_random_uuid()::text, '-', ''),
       "partnerships"."workspace_id",
       "partnership_people"."person_id",
       'partnership',
       "partnership_people"."partnership_id"
FROM "partnership_people"
JOIN "partnerships" ON "partnerships"."id" = "partnership_people"."partnership_id"
ON CONFLICT ("person_id", "target_type", "target_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "person_links" ("id", "workspace_id", "person_id", "target_type", "target_id")
SELECT 'plink_' || replace(gen_random_uuid()::text, '-', ''),
       "raises"."workspace_id",
       "raise_people"."person_id",
       'raise',
       "raise_people"."raise_id"
FROM "raise_people"
JOIN "raises" ON "raises"."id" = "raise_people"."raise_id"
ON CONFLICT ("person_id", "target_type", "target_id") DO NOTHING;