-- Domain is the company homepage. `website` was a second URL that almost
-- always repeated `https://` plus the same host. Fill a blank domain from
-- that URL, then drop the column. Visit on the heading opens https://{domain}.
UPDATE "companies" AS c
SET "domain" = v.host
FROM (
  SELECT DISTINCT ON (workspace_id, host)
    id,
    workspace_id,
    host
  FROM (
    SELECT
      id,
      workspace_id,
      NULLIF(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(trim(website)), '^[a-z][a-z0-9+.-]*://', ''),
            '/.*$',
            ''
          ),
          '\.$',
          ''
        ),
        ''
      ) AS host
    FROM "companies"
    WHERE "domain" IS NULL AND "website" IS NOT NULL
  ) AS sourced
  WHERE host IS NOT NULL
  ORDER BY workspace_id, host, id
) AS v
WHERE c.id = v.id
  AND NOT EXISTS (
    SELECT 1
    FROM "companies" AS other
    WHERE other.workspace_id = c.workspace_id
      AND other.domain = v.host
      AND other.id <> c.id
  );
--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "website";
--> statement-breakpoint
UPDATE "form_fields"
SET "map_to" = 'company.domain'
WHERE "map_to" = 'company.website';
--> statement-breakpoint
UPDATE "import_jobs"
SET "column_map" = ("column_map" - 'website') || jsonb_build_object('domain', "column_map"->>'website')
WHERE jsonb_typeof("column_map") = 'object'
  AND "column_map" ? 'website'
  AND "column_map"->>'website' IS NOT NULL
  AND NOT (
    "column_map" ? 'domain'
    AND "column_map"->>'domain' IS NOT NULL
  );
--> statement-breakpoint
UPDATE "import_jobs"
SET "column_map" = "column_map" - 'website'
WHERE jsonb_typeof("column_map") = 'object'
  AND "column_map" ? 'website';
--> statement-breakpoint
UPDATE "import_jobs"
SET "match_key" = 'domain'
WHERE "object" = 'companies'
  AND "match_key" = 'website';
