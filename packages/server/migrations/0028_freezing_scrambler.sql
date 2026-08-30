-- Hand-ordered. Drizzle Kit emitted the `search_vector` rebuild before the
-- columns that rebuild reads, and dropping a generated column drops the index
-- over it, which Drizzle then never recreated. Two edits to what it generated:
--
--   1. The four `people` columns are added first. Postgres validates a generated
--      expression at ADD COLUMN time, so the original order failed outright on
--      `column "first_name" does not exist`.
--   2. `people_search_idx` is recreated after the column comes back. Nothing
--      would have failed without it — search would have gone on answering, from
--      a sequential scan of every person in the installation.
ALTER TABLE "people" ADD COLUMN "salutation" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "suffix" text;--> statement-breakpoint
ALTER TABLE "people" drop column "search_vector";--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', regexp_replace(coalesce("people"."name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("people"."first_name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("people"."last_name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("people"."email"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce("people"."summary"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce(kelpie_text_array_to_string("people"."tags"), ''), '[^[:alnum:]]+', ' ', 'g')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "people_search_idx" ON "people" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "form_fields" DROP CONSTRAINT "form_fields_map_to_check";--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_map_to_check" CHECK ("form_fields"."map_to" in ('person.name', 'person.first_name', 'person.last_name', 'person.email', 'company.name', 'company.domain', 'position.title', 'deal.name', 'opportunity.name', 'partnership.name', 'submission'));
