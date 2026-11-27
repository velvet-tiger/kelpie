-- A company's size band is optional. A company nobody has sized has no band,
-- where before it was given `1-10`.
-- Every band stored as `1-10` is cleared. The old default wrote `1-10` for each
-- company created without a band, so a stored `1-10` cannot be told apart from
-- a band somebody chose, and most of them are the default. The other bands were
-- always given by somebody, so they stay.
-- The check constraint already passes a null, so it is unchanged.
-- Running it twice changes nothing: the second run finds no `1-10`.
-- Hand-written: the drizzle-kit snapshot chain is stale.
ALTER TABLE "companies" ALTER COLUMN "size_band" DROP NOT NULL;--> statement-breakpoint
UPDATE "companies" SET "size_band" = NULL WHERE "size_band" = '1-10';
