-- One OAuth connection can now cover more than one workspace.
-- `oauth_connections` is one approval on the consent page. A grant stays one
-- user, one workspace and one client, and now belongs to a connection. A code
-- or a token belongs to the connection, not to one grant, so it reaches each
-- workspace that has a grant under the connection.
-- Each grant from before gets its own connection, and its codes and tokens
-- move to that connection. No live connection is lost.
-- `oauth_tokens.grant_id` is dropped. Code from before this migration cannot
-- write a token after it, so a client that signs in while a deploy is in
-- progress can get an error and must try again.
-- Hand-written: the drizzle-kit snapshot chain is stale.
CREATE TABLE "oauth_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_row_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_client_row_id_oauth_clients_id_fk" FOREIGN KEY ("client_row_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_connections_user_idx" ON "oauth_connections" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "connection_id" text;--> statement-breakpoint
INSERT INTO "oauth_connections" ("id", "user_id", "client_row_id", "created_at")
	SELECT 'ocn_' || substr("id", 5), "user_id", "client_row_id", "created_at" FROM "oauth_grants";--> statement-breakpoint
UPDATE "oauth_grants" SET "connection_id" = 'ocn_' || substr("id", 5);--> statement-breakpoint
ALTER TABLE "oauth_grants" ALTER COLUMN "connection_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_grants_connection_id_idx" ON "oauth_grants" USING btree ("connection_id");--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "connection_id" text;--> statement-breakpoint
UPDATE "oauth_tokens" SET "connection_id" = "oauth_grants"."connection_id" FROM "oauth_grants" WHERE "oauth_grants"."id" = "oauth_tokens"."grant_id";--> statement-breakpoint
ALTER TABLE "oauth_tokens" ALTER COLUMN "connection_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "oauth_tokens_grant_idx";--> statement-breakpoint
ALTER TABLE "oauth_tokens" DROP COLUMN "grant_id";--> statement-breakpoint
CREATE INDEX "oauth_tokens_connection_idx" ON "oauth_tokens" USING btree ("connection_id");
