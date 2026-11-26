-- Members and invitations have their own scopes now: `members:read` reads them
-- and `members:write` changes them. Before this, `workspace:read` and
-- `workspace:write` covered them. This keeps what each stored credential can
-- do today.
-- Each stored scope list that holds `workspace:read` gets `members:read`, and
-- each one that holds `workspace:write` gets `members:write`. A list that
-- holds the new scope already is not given it again, so a second run changes
-- nothing. An empty list stays empty: on an API key it means full access, and
-- no OAuth row has one.
-- No list gets a power it did not have. `members:write` implies `members:read`,
-- as `workspace:write` implied `workspace:read` before, so a list with only
-- `workspace:write` keeps reading the members.
-- Presets are not stored as the scopes they expand to, so `read:all`,
-- `write:all`, `read:admin`, `write:admin` and `admin` need no change. They
-- expand to the new scopes when they are used.
-- The tables are `api_keys`, `oauth_grants` and `oauth_tokens`, as in
-- migration 0065. `oauth_requests` is not changed: a pending request holds no
-- power yet.
-- Hand-written: the drizzle-kit snapshot chain is stale.
UPDATE "api_keys" SET "scopes" = array_append("scopes", 'members:read') WHERE 'workspace:read' = ANY("scopes") AND NOT ('members:read' = ANY("scopes"));--> statement-breakpoint
UPDATE "api_keys" SET "scopes" = array_append("scopes", 'members:write') WHERE 'workspace:write' = ANY("scopes") AND NOT ('members:write' = ANY("scopes"));--> statement-breakpoint
UPDATE "oauth_grants" SET "scopes" = array_append("scopes", 'members:read') WHERE 'workspace:read' = ANY("scopes") AND NOT ('members:read' = ANY("scopes"));--> statement-breakpoint
UPDATE "oauth_grants" SET "scopes" = array_append("scopes", 'members:write') WHERE 'workspace:write' = ANY("scopes") AND NOT ('members:write' = ANY("scopes"));--> statement-breakpoint
UPDATE "oauth_tokens" SET "scopes" = array_append("scopes", 'members:read') WHERE 'workspace:read' = ANY("scopes") AND NOT ('members:read' = ANY("scopes"));--> statement-breakpoint
UPDATE "oauth_tokens" SET "scopes" = array_append("scopes", 'members:write') WHERE 'workspace:write' = ANY("scopes") AND NOT ('members:write' = ANY("scopes"));
