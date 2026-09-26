-- Kelpie AI rows written before core 0.16.0 have managed_by null, and the
-- module now finds its row by managed_by. Claim one "Kelpie AI" row in each
-- workspace that has AI enabled. The old code wrote that row on enable and
-- overwrote any same-named row, so in those workspaces the row is ours. A
-- workspace without ai_settings is left alone: a row there is an admin's own.
-- DISTINCT ON takes one row per workspace, because the partial unique index
-- allows only one; any other duplicate stays an ordinary, removable row.
UPDATE "agent_registrations" AS "target"
SET "managed_by" = 'ai', "settings_path" = '/admin/ai'
FROM (
  SELECT DISTINCT ON ("registration"."workspace_id") "registration"."id"
  FROM "agent_registrations" AS "registration"
  INNER JOIN "ai_settings" ON "ai_settings"."workspace_id" = "registration"."workspace_id"
  WHERE "registration"."name" = 'Kelpie AI'
    AND "registration"."managed_by" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "agent_registrations" AS "managed"
      WHERE "managed"."workspace_id" = "registration"."workspace_id"
        AND "managed"."managed_by" = 'ai'
    )
  ORDER BY "registration"."workspace_id", "registration"."created_at", "registration"."id"
) AS "claimed"
WHERE "target"."id" = "claimed"."id";
