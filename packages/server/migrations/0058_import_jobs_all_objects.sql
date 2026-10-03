-- `import_jobs_object_check` still allowed only the four objects import started
-- with. `IMPORT_OBJECTS` and the import code have carried nine since the import
-- grew to every CRM object, so a job for opportunities, enquiries, partnerships,
-- raises or custom_fields passed validation and then failed on this constraint.
-- Hand-written: the drizzle-kit snapshot chain is stale.
ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_object_check";--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_object_check" CHECK ("import_jobs"."object" in ('companies', 'people', 'positions', 'deals', 'opportunities', 'enquiries', 'partnerships', 'raises', 'custom_fields'));
