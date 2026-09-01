import {
  EXPORT_OBJECTS,
  IMPORT_CONFLICT_MODES,
  IMPORT_OBJECTS,
  IMPORT_SOURCES,
  MAX_IMPORT_FILE_BYTES,
  ON_MISSING_COMPANY,
  defaultMatchKeyId,
} from '@kelpie/schemas'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg } from '../crudTools.ts'
import { importJobResponse } from './routes.ts'
import type { ImportExportService } from './service.ts'

/**
 * The four tools `import-export.md` names: `export_csv`, `import_preview`,
 * `import_commit`, `import_job_get`.
 *
 * The file arrives as a string rather than as multipart, which is the one
 * difference from the REST endpoints. Both surfaces call the same service with
 * the same bytes; multipart exists on the wire because a browser uploads a file,
 * and MCP has no file to upload.
 */

/**
 * How much CSV `export_csv` will inline.
 *
 * A tool result is read into a model's context, so a whole workspace's people is
 * the wrong thing to hand back by accident. Over the limit the tool refuses and
 * names the REST download, rather than truncating: half a CSV looks exactly like
 * a whole one, and an agent would draw conclusions from the missing rows.
 */
export const MAX_INLINE_EXPORT_BYTES = 256 * 1024

const exportObjectArg = z
  .enum(EXPORT_OBJECTS)
  .describe(`Which object to export. One of: ${EXPORT_OBJECTS.join(', ')}.`)

const importObjectArg = z
  .enum(IMPORT_OBJECTS)
  .describe(`Which object to import. One of: ${IMPORT_OBJECTS.join(', ')}.`)

/** `column_map` is a real object here. The multipart route takes it as a JSON string. */
const columnMapArg = z
  .record(z.string(), z.string().nullable())
  .describe(
    'Kelpie column to source header, or null to ignore that column. Omit to derive one ' +
      'from the source preset and the file\'s own headers.',
  )

const csvArg = z
  .string()
  .min(1)
  .max(MAX_IMPORT_FILE_BYTES)
  .describe('The CSV file, as text. UTF-8, with a header row.')

const previewArgs = z.strictObject({
  source: z.enum(IMPORT_SOURCES).describe('Which export the file came out of.'),
  object: importObjectArg,
  csv: csvArg,
  conflict_mode: z
    .enum(IMPORT_CONFLICT_MODES)
    .default('skip')
    .describe('What to do with a row that matches an existing record.'),
  on_missing_company: z
    .enum(ON_MISSING_COMPANY)
    .default('skip')
    .describe(
      'People import only: what to do when a row names a company that is not here yet. ' +
        "'skip' imports the person and leaves the position unlinked; 'create' invents the company.",
    ),
  match_key: z.string().min(1).optional().describe('Which field decides that match.'),
  column_map: columnMapArg.optional(),
  consent_purpose_id: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .describe(
      'People imports only: the consent purpose a row grants for each `consent_status`. ' +
        'Required whenever consent_status or consent_at is mapped.',
    ),
  file_name: z.string().min(1).nullable().default(null).describe('Recorded on the job, for the log.'),
})

async function collectCsv(lines: AsyncIterable<string>): Promise<string> {
  const parts: string[] = []
  let bytes = 0

  for await (const line of lines) {
    bytes += Buffer.byteLength(line, 'utf8')

    if (bytes > MAX_INLINE_EXPORT_BYTES) {
      throw AppError.validationFailed(
        `That export is over ${String(MAX_INLINE_EXPORT_BYTES / 1024)} KB, which is more than a tool result should carry`,
        [
          {
            field: 'object',
            message: 'Download it from GET /v1/export/{object}.csv with the same API key',
          },
        ],
      )
    }

    parts.push(line)
  }

  return parts.join('')
}

export function registerImportExportTools(mcp: McpToolRegistry, service: ImportExportService): void {
  mcp.tool({
    name: 'export_csv',
    description:
      'Export every record of one object as CSV text. Refuses an export too large to sit in ' +
      'a tool result, and names the download to use instead. Mirrors GET /v1/export/{object}.csv.',
    inputSchema: z.strictObject({ object: exportObjectArg }),
    invoke: async ({ object }, actor) => ({
      object,
      csv: await collectCsv(service.exportCsv(actor, object)),
    }),
  })

  mcp.tool({
    name: 'export_template_csv',
    description:
      'The header row Kelpie expects for one object, with no records in it. Start a hand-built ' +
      'import from this. Mirrors GET /v1/export/templates/{object}.csv.',
    inputSchema: z.strictObject({ object: exportObjectArg }),
    invoke: async ({ object }, actor) => ({
      object,
      csv: await service.templateCsv(actor, object),
    }),
  })

  mcp.tool({
    name: 'import_preview',
    description:
      'Dry-run a CSV: creates an import job, reports per-row create, update, skip and error ' +
      'counts, and writes nothing. Commit it afterwards with import_commit and the same file. ' +
      'Mirrors POST /v1/import/jobs.',
    inputSchema: previewArgs,
    invoke: async (args, actor) =>
      importJobResponse(
        await service.createJob(actor, {
          source: args.source,
          object: args.object,
          conflictMode: args.conflict_mode,
          onMissingCompany: args.on_missing_company,
          matchKeyId: args.match_key ?? defaultMatchKeyId(args.object),
          columnMap: args.column_map,
          consentPurposeId: args.consent_purpose_id,
          fileName: args.file_name,
          csv: args.csv,
        }),
      ),
  })

  mcp.tool({
    name: 'import_commit',
    description:
      'Apply a job that was dry-run. Send back the same file: a job keeps only its digest, ' +
      'and a different one is refused. Re-running a commit is safe. Mirrors ' +
      'POST /v1/import/jobs/{id}/commit.',
    inputSchema: z.strictObject({ id: idArg, csv: csvArg }),
    invoke: async ({ id, csv }, actor) => importJobResponse(await service.commit(actor, id, csv)),
  })

  mcp.tool({
    name: 'import_job_get',
    description:
      'Read a job: status, counts and per-row errors. Poll this while a job is validating or ' +
      'committing. Mirrors GET /v1/import/jobs/{id}.',
    inputSchema: z.strictObject({ id: idArg }),
    invoke: async ({ id }, actor) => importJobResponse(await service.getJob(actor, id)),
  })
}
