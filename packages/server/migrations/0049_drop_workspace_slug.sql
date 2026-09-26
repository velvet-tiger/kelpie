-- Nothing looked a workspace up by slug: it named no route and no URL. The
-- delete confirmation now takes the workspace name. Dropping the column drops
-- its unique constraint with it.
ALTER TABLE "workspaces" DROP COLUMN "slug";
