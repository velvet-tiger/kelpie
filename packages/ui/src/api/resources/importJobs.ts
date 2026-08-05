import { importJobSchema, isImportJobSettled } from '@kelpie/schemas'
import type {
  ImportColumnMap,
  ImportConflictMode,
  ImportJob,
  ImportObject,
  ImportSource,
} from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult, RecordResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * Import jobs and CSV export.
 *
 * Hand-written rather than built from `createResourceHooks`: an import job is
 * not a CRM collection. It is created by uploading a file, read while it is
 * still running, and finished by a second `POST` — none of which the five shared
 * verbs describe.
 */

/** How often a job that is still working is asked again. */
const POLL_INTERVAL_MS = 750

export interface CreateImportJobInput {
  readonly file: File
  readonly source: ImportSource
  readonly object: ImportObject
  readonly conflictMode: ImportConflictMode
  readonly matchKeyId: string
  /**
   * Absent on the first upload, so the server derives one from the source preset
   * and the file's own headers. The mapping screen sends the corrected map back
   * with the same file.
   */
  readonly columnMap?: ImportColumnMap
}

function jobForm(input: CreateImportJobInput): FormData {
  const form = new FormData()

  form.set('file', input.file)
  form.set('source', input.source)
  form.set('object', input.object)
  form.set('conflict_mode', input.conflictMode)
  form.set('match_key', input.matchKeyId)
  form.set('dry_run', 'true')

  if (input.columnMap !== undefined) {
    form.set('column_map', JSON.stringify(input.columnMap))
  }

  return form
}

/** The cache entry `useImportJob` reads, so a write and the watcher agree. */
function jobKey(id: string): readonly unknown[] {
  return ['import-jobs', 'detail', id]
}

export function useCreateImportJob(): MutationResult<CreateImportJobInput, ImportJob> {
  const client = useApiClient()
  const cache = useQueryClient()

  return asMutationResult(
    useMutation({
      mutationFn: (input: CreateImportJobInput) =>
        client.postForm('/import/jobs', jobForm(input), importJobSchema.parse),
      // Seeds the watcher rather than letting it fetch what this response already
      // carries. For a file large enough to validate in the background, that
      // seed is also what starts the polling.
      onSuccess: (job) => {
        cache.setQueryData(jobKey(job.id), job)
      },
    }),
  )
}

export interface CommitImportJobInput {
  readonly id: string
  /**
   * The same file the dry run read. A job keeps only its digest, so the bytes
   * come back here and the server refuses anything that hashes differently.
   * The wizard has held this `File` since the upload for exactly this reason.
   */
  readonly file: File
}

/**
 * Commits a job, sending back the file it forecast.
 *
 * The response replaces the cached job, which is what restarts polling: the
 * watcher stops while a job sits in `ready`, and a commit moves it to
 * `committing` or `completed`. It also invalidates every CRM list, because the
 * records this just wrote are in all of them.
 */
export function useCommitImportJob(): MutationResult<CommitImportJobInput, ImportJob> {
  const client = useApiClient()
  const cache = useQueryClient()

  return asMutationResult(
    useMutation({
      mutationFn: ({ id, file }: CommitImportJobInput) => {
        const form = new FormData()

        form.set('file', file)

        return client.postForm(`/import/jobs/${id}/commit`, form, importJobSchema.parse)
      },
      onSuccess: async (job) => {
        cache.setQueryData(jobKey(job.id), job)

        await Promise.all(
          ['people', 'companies', 'positions', 'deals', 'activities'].map((name) =>
            cache.invalidateQueries({ queryKey: [name] }),
          ),
        )
      },
    }),
  )
}

/**
 * Deletes a job and the rows stored against it.
 *
 * What a wizard calls on the job it is walking away from. Correcting a mapping
 * uploads the same file again as a new job, so without this a caller who
 * corrects a ten thousand row map three times leaves three files stored.
 *
 * No CRM list is invalidated: a job that never committed wrote nothing, and one
 * that did keeps the records it wrote.
 */
export function useDeleteImportJob(): MutationResult<string, void> {
  const client = useApiClient()
  const cache = useQueryClient()

  return asMutationResult(
    useMutation({
      mutationFn: (id: string) => client.delete(`/import/jobs/${id}`),
      onSuccess: (_result, id) => {
        // Dropped rather than invalidated. Refetching a deleted job is a 404,
        // and the watcher would report it as one.
        cache.removeQueries({ queryKey: jobKey(id) })
      },
    }),
  )
}

/**
 * Watches one job, asking again while it is still working.
 *
 * A file over the synchronous limit validates and commits in the background, so
 * the only way to learn it finished is to look. Polling stops the moment the
 * status settles, which for a small file is the first read.
 */
export function useImportJob(id: string | undefined): RecordResult<ImportJob> {
  const client = useApiClient()
  const query = useQuery({
    queryKey: jobKey(id ?? ''),
    enabled: id !== undefined,
    queryFn: () => client.get(`/import/jobs/${String(id)}`, importJobSchema.parse),
    refetchInterval: (query) =>
      query.state.data !== undefined && isImportJobSettled(query.state.data.status)
        ? false
        : POLL_INTERVAL_MS,
  })

  const error = toError(query.error)

  return {
    record: query.data,
    isLoading: query.isPending && id !== undefined,
    error,
    isNotFound: error !== null && 'status' in error && error.status === 404,
  }
}

export interface CsvDownload {
  readonly fileName: string
  readonly csv: string
}

/**
 * Fetches an export through the API client rather than pointing the browser at
 * the URL.
 *
 * A plain link would work for a session cookie and not for anything else, and it
 * would render the server's error body as a page if the request failed. This way
 * a failure is an `ApiError` the page can show beside the button.
 */
export function useExportCsv(): MutationResult<
  { object: ImportObject; template: boolean },
  CsvDownload
> {
  const client = useApiClient()

  return asMutationResult(
    useMutation({
      mutationFn: async ({
        object,
        template,
      }: {
        object: ImportObject
        template: boolean
      }): Promise<CsvDownload> => {
        const path = template ? `/export/templates/${object}.csv` : `/export/${object}.csv`

        return {
          fileName: template ? `kelpie-${object}-template.csv` : `kelpie-${object}.csv`,
          csv: await client.getText(path),
        }
      },
    }),
  )
}

/** Hands the browser a file it never fetched from a URL. */
export function saveCsv(download: CsvDownload): void {
  const url = URL.createObjectURL(new Blob([download.csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')

  link.href = url
  link.download = download.fileName
  link.click()
  URL.revokeObjectURL(url)
}
