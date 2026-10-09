-- Scopes change meaning in this release, and this keeps what each stored
-- credential can do today.
-- Before: `write:objects` included `handbook:write`, and a `DELETE` on an
-- object-data resource needed that resource's write scope.
-- After: `write:objects` does not include `handbook:write`, and a delete needs
-- `<resource>:delete`, which `delete:objects` gives for every object-data
-- resource. Nothing but an empty scope list on an API key implies either.
-- Each stored scope list gets the scopes it must now name to keep its powers:
--   `write:objects`    -> `handbook:write` and `delete:objects`
--   `write:all`        -> `delete:objects`
--   `<resource>:write` -> `<resource>:delete`, for an object-data resource
-- A list that names the new scope already, or names one that includes it, is
-- not given it again, so a second run changes nothing. An empty list stays
-- empty: on an API key it means full access, and no OAuth row has one.
-- No list gets a power it did not have: each added scope allows only what the
-- scope it comes from allowed before this migration.
-- The tables are `api_keys`, `oauth_grants` and `oauth_tokens`. The last one
-- holds authorization codes, access tokens and refresh tokens, and a new token
-- copies the scopes of the refresh token it comes from.
-- `oauth_requests` is not changed. A pending request is a question that no
-- person has answered, so it holds no power to keep. Its consent page offers
-- `handbook:write` and `delete:objects` as extra permissions.
-- The resource list is written out here and not read from the code: a
-- migration must do the same thing whenever it runs.
-- Hand-written: the drizzle-kit snapshot chain is stale.
CREATE FUNCTION "kelpie_0065_scopes"("held" text[]) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
	SELECT "held" || COALESCE(array_agg("added"."scope" ORDER BY "added"."position"), '{}'::text[])
	FROM (
		SELECT 'handbook:write' AS "scope", 0 AS "position"
			WHERE 'write:objects' = ANY("held") AND NOT ('write:all' = ANY("held"))
		UNION ALL
		SELECT 'delete:objects', 1
			WHERE 'write:objects' = ANY("held") OR 'write:all' = ANY("held")
		UNION ALL
		SELECT "resource"."name" || ':delete', 1 + "resource"."position"
			FROM unnest(ARRAY[
				'people', 'companies', 'positions', 'deals', 'enquiries', 'opportunities',
				'partnerships', 'raises', 'roles', 'candidates', 'events', 'attendances',
				'decisions', 'plan_items', 'notes', 'lists', 'handbook', 'forms'
			]) WITH ORDINALITY AS "resource"("name", "position")
			WHERE ("resource"."name" || ':write') = ANY("held")
				AND NOT ('write:objects' = ANY("held") OR 'write:all' = ANY("held") OR 'delete:objects' = ANY("held"))
	) AS "added"
	WHERE NOT ("added"."scope" = ANY("held"))
$$;--> statement-breakpoint
UPDATE "api_keys" SET "scopes" = "kelpie_0065_scopes"("scopes") WHERE "scopes" <> "kelpie_0065_scopes"("scopes");--> statement-breakpoint
UPDATE "oauth_grants" SET "scopes" = "kelpie_0065_scopes"("scopes") WHERE "scopes" <> "kelpie_0065_scopes"("scopes");--> statement-breakpoint
UPDATE "oauth_tokens" SET "scopes" = "kelpie_0065_scopes"("scopes") WHERE "scopes" <> "kelpie_0065_scopes"("scopes");--> statement-breakpoint
DROP FUNCTION "kelpie_0065_scopes"(text[]);
