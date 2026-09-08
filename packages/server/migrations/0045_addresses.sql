-- Postal addresses on people and companies. jsonb, like phones and social
-- profiles: nothing queries into the parts, and the route layer is what
-- validates the shape. `kelpie_addresses_search_text` is hand-added because
-- Drizzle Kit does not manage functions, the same reason `kelpie_text_array_to_string`
-- lives in 0015. jsonb_array_elements is STABLE; the wrapper asserts IMMUTABLE
-- so a generated search_vector can read it.
--
-- Stored keys match the TypeScript shape (`postalCode`), not the wire
-- (`postal_code`). The route maps at the boundary the same way it does for
-- every other resource.
CREATE OR REPLACE FUNCTION kelpie_addresses_search_text(jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$
    SELECT coalesce((
      SELECT string_agg(trim(both ' ' from concat_ws(' ',
        nullif(elem->>'line1', ''),
        nullif(elem->>'line2', ''),
        nullif(elem->>'city', ''),
        nullif(elem->>'region', ''),
        nullif(elem->>'postalCode', ''),
        nullif(elem->>'country', '')
      )), ' ')
      FROM jsonb_array_elements($1) AS t(elem)
    ), '')
  $$;
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "addresses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "addresses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "people"
SET "addresses" = jsonb_build_array(
  jsonb_build_object(
    'kind', 'home',
    'line1', null,
    'line2', null,
    'city', "location",
    'region', null,
    'postalCode', null,
    'country', null,
    'primary', true
  )
)
WHERE "location" IS NOT NULL AND btrim("location") <> '';--> statement-breakpoint
UPDATE "companies"
SET "addresses" = jsonb_build_array(
  jsonb_build_object(
    'kind', 'hq',
    'line1', null,
    'line2', null,
    'city', "hq",
    'region', null,
    'postalCode', null,
    'country', null,
    'primary', true
  )
)
WHERE "hq" IS NOT NULL AND btrim("hq") <> '';--> statement-breakpoint
UPDATE "form_fields" SET "map_to" = 'person.address.city' WHERE "map_to" = 'person.location';--> statement-breakpoint
UPDATE "form_fields" SET "map_to" = 'company.address.city' WHERE "map_to" = 'company.hq';--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "location";--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "hq";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', regexp_replace(coalesce("people"."name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("people"."first_name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("people"."last_name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("people"."email"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce("people"."summary"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce(kelpie_text_array_to_string("people"."tags"), ''), '[^[:alnum:]]+', ' ', 'g')), 'C') || setweight(to_tsvector('english', regexp_replace(coalesce(kelpie_addresses_search_text("people"."addresses"), ''), '[^[:alnum:]]+', ' ', 'g')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "people_search_idx" ON "people" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', regexp_replace(coalesce("companies"."name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("companies"."domain"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce("companies"."industry"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce("companies"."description"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce("companies"."summary"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce(kelpie_text_array_to_string("companies"."tags"), ''), '[^[:alnum:]]+', ' ', 'g')), 'C') || setweight(to_tsvector('english', regexp_replace(coalesce(kelpie_text_array_to_string("companies"."tech_stack"), ''), '[^[:alnum:]]+', ' ', 'g')), 'C') || setweight(to_tsvector('english', regexp_replace(coalesce(kelpie_addresses_search_text("companies"."addresses"), ''), '[^[:alnum:]]+', ' ', 'g')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "companies_search_idx" ON "companies" USING gin ("search_vector");
