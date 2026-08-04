import {
  IMPORT_CONFLICT_MODES,
  IMPORT_OBJECTS,
  IMPORT_SOURCES,
  MAX_IMPORT_FILE_BYTES,
  defaultMatchKeyId,
} from '@kelpie/schemas'
import type { ImportColumnMap, ImportObject } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { stream } from 'hono/streaming'
import { z } from 'zod'

import { AppError, toErrorDetails } from '../../lib/errors.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { ImportExportService, ImportJobView } from './service.ts'

/**
 * `/v1/export` and `/v1/import`, per `import-export.md`.
 *
 * The upload is `multipart/form-data` rather than JSON, because the thing being
 * uploaded is a file and base64 in a JSON body would put a third of the ten
 * megabyte limit into encoding. Its text fields are validated by the same Zod
 * schema a JSON body would use.
 */

/** The file name a download is offered under. */
const DOWNLOAD_PREFIX = 'kelpie'

const objectFile = z.enum(IMPORT_OBJECTS.map((object) => `${object}.csv`) as [string, ...string[]])

/**
 * `column_map` arrives as a JSON string inside the form, since a multipart field
 * carries text. Absent means "derive one", which is not the same as `{}`: an
 * empty object is a map that ignores every column, and it fails the required
 * column check as it should.
 */
const columnMapSchema = z.record(z.string(), z.string().nullable())

const createJobForm = z.object({
  source: z.enum(IMPORT_SOURCES),
  object: z.enum(IMPORT_OBJECTS),
  conflict_mode: z.enum(IMPORT_CONFLICT_MODES).default('skip'),
  match_key: z.string().min(1).optional(),
  column_map: z.string().optional(),
  dry_run: z.enum(['true', 'false']).default('true'),
})

export interface ImportExportRoutesDependencies extends CredentialDependencies {
  readonly service: ImportExportService
}

export function importJobResponse(job: ImportJobView): Record<string, unknown> {
  return {
    id: job.id,
    source: job.source,
    object: job.object,
    status: job.status,
    conflict_mode: job.conflictMode,
    match_key: job.matchKey,
    column_map: job.columnMap,
    source_headers: job.sourceHeaders,
    file_name: job.fileName,
    counts: job.counts,
    errors: job.errors,
    preview: job.preview,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
  }
}

/** `people.csv` → `people`. The route's own param, so an unknown one is a 404. */
function readObjectFile(context: Context): ImportObject {
  const parsed = objectFile.safeParse(context.req.param('file'))

  if (!parsed.success) {
    throw AppError.notFound(
      `Export ${IMPORT_OBJECTS.map((object) => `${object}.csv`).join(', ')}`,
    )
  }

  return parsed.data.replace(/\.csv$/u, '') as ImportObject
}

function csvHeaders(fileName: string): Record<string, string> {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    // A workspace's data is not a thing to leave in a shared cache.
    'Cache-Control': 'private, no-store',
  }
}

function readColumnMap(raw: string | undefined): ImportColumnMap | undefined {
  if (raw === undefined) {
    return undefined
  }

  const parsed: unknown = ((): unknown => {
    try {
      return JSON.parse(raw)
    } catch {
      throw AppError.validationFailed('column_map must be a JSON object', [
        { field: 'column_map', message: 'Could not read it as JSON' },
      ])
    }
  })()

  const map = columnMapSchema.safeParse(parsed)

  if (!map.success) {
    throw AppError.validationFailed(
      'column_map must map Kelpie columns to source headers or null',
      toErrorDetails(map.error.issues),
    )
  }

  return map.data
}

/**
 * Pulls the upload off the request.
 *
 * @throws AppError 400 when the body is not multipart at all, 422 when the file
 *   is missing or over the limit. A body Hono cannot read as a form is the
 *   caller sending the wrong content type, which is a different mistake from
 *   sending a form with the wrong fields in it.
 */
async function readUpload(context: Context): Promise<{ file: File; fields: Record<string, string> }> {
  const body = await context.req.parseBody().catch(() => {
    throw new AppError('bad_request', 'Send the job as multipart/form-data')
  })
  const file = body.file

  if (!(file instanceof File)) {
    throw AppError.validationFailed('The job needs a CSV file', [
      { field: 'file', message: 'Missing' },
    ])
  }

  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw AppError.validationFailed(
      `A file may be at most ${String(MAX_IMPORT_FILE_BYTES / 1024 / 1024)} MB`,
      [{ field: 'file', message: `This one is ${String(file.size)} bytes` }],
    )
  }

  const fields: Record<string, string> = {}

  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      fields[key] = value
    }
  }

  return { file, fields }
}

export function mountImportExportRoutes(
  router: Hono,
  dependencies: ImportExportRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  /**
   * Streams the object as CSV.
   *
   * The actor is resolved before the stream opens. A `401` has to be a `401`
   * with an error body, and once the first chunk is written the status is
   * already sent.
   */
  router.get('/export/:file', async (context) => {
    const object = readObjectFile(context)
    const actor = await requireActor(context)
    const lines = dependencies.service.exportCsv(actor, object)
    const encoder = new TextEncoder()

    for (const [header, value] of Object.entries(
      csvHeaders(`${DOWNLOAD_PREFIX}-${object}.csv`),
    )) {
      context.header(header, value)
    }

    return stream(context, async (writable) => {
      for await (const line of lines) {
        await writable.write(encoder.encode(line))
      }
    })
  })

  router.get('/export/templates/:file', async (context) => {
    const object = readObjectFile(context)

    await requireActor(context)

    return context.body(
      dependencies.service.templateCsv(object),
      200,
      csvHeaders(`${DOWNLOAD_PREFIX}-${object}-template.csv`),
    )
  })

  /**
   * Creates a job and dry-runs it.
   *
   * `dry_run` must be `true`: `import-export.md` makes the commit a separate
   * call, so a create claiming otherwise is asking for something this endpoint
   * will not do rather than something it can quietly ignore.
   */
  router.post('/import/jobs', async (context) => {
    const actor = await requireActor(context)
    const { file, fields } = await readUpload(context)
    const parsed = createJobForm.safeParse(fields)

    if (!parsed.success) {
      throw AppError.validationFailed('The job is missing something', toErrorDetails(parsed.error.issues))
    }

    if (parsed.data.dry_run !== 'true') {
      throw AppError.validationFailed('A new job is always a dry run', [
        {
          field: 'dry_run',
          message: 'Create the job, then POST to /import/jobs/{id}/commit',
        },
      ])
    }

    const job = await dependencies.service.createJob(actor, {
      source: parsed.data.source,
      object: parsed.data.object,
      conflictMode: parsed.data.conflict_mode,
      matchKeyId: parsed.data.match_key ?? defaultMatchKeyId(parsed.data.object),
      columnMap: readColumnMap(parsed.data.column_map),
      fileName: file.name.length === 0 ? null : file.name,
      csv: await file.text(),
    })

    // 202 when the work is still running, 201 when it is done. Both created the
    // job; only one of them has an answer about the file in it yet.
    return context.json(importJobResponse(job), job.status === 'validating' ? 202 : 201)
  })

  router.get('/import/jobs/:id', async (context) => {
    const job = await dependencies.service.getJob(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(importJobResponse(job))
  })

  router.post('/import/jobs/:id/commit', async (context) => {
    const job = await dependencies.service.commit(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(importJobResponse(job), job.status === 'committing' ? 202 : 200)
  })
}
