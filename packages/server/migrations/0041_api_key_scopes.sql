ALTER TABLE "api_keys" ADD COLUMN "scopes" text[] DEFAULT '{}' NOT NULL;
