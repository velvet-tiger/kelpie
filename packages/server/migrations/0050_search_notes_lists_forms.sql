-- Notes, lists and forms become searchable, so the note editor's `[[` picker
-- can link to them. Plan items and decisions already carry a vector.
ALTER TABLE "notes" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', regexp_replace(coalesce("notes"."body"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A')) STORED;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', regexp_replace(coalesce("lists"."name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("lists"."description"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B')) STORED;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', regexp_replace(coalesce("forms"."name"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("forms"."title"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B') || setweight(to_tsvector('english', regexp_replace(coalesce("forms"."description"::text, ''), '[^[:alnum:]]+', ' ', 'g')), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "notes_search_idx" ON "notes" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "lists_search_idx" ON "lists" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "forms_search_idx" ON "forms" USING gin ("search_vector");
