-- Every sign-in now deletes the sessions that have expired. This index keeps
-- that delete from scanning the whole table.
-- No row is changed.
-- Hand-written: the drizzle-kit snapshot chain is stale.
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");
