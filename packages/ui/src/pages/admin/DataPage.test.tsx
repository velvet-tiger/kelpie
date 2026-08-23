import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { ApiError } from '../../api/client.ts'
import type { ApiClient } from '../../api/client.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { DataPage } from './DataPage.tsx'

afterEach(cleanup)

/**
 * The wizard's own account of the files it uploaded.
 *
 * A corrected mapping is a new job over the same file, so every correction
 * stores the file again. What these cover is the other half of that: the wizard
 * deleting the job it walked away from, on each of the three ways out of one.
 */

/** An ImportJob as the API sends one, which is what `importJobSchema` decodes. */
function wireJob(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    source: 'custom',
    object: 'companies',
    status: 'ready',
    conflict_mode: 'skip',
    on_missing_company: 'skip',
    match_key: 'domain',
    column_map: { name: 'name', domain: 'domain' },
    source_headers: ['name', 'domain'],
    file_name: 'companies.csv',
    counts: { total: 2, create: 2, update: 0, skip: 0, error: 0 },
    errors: [],
    warnings: [],
    preview: [],
    created_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
    ...extra,
  }
}

interface Harness {
  /** The paths the page asked to delete, in the order it asked. */
  readonly deleted: string[]
  /** The id each successive upload answers with. */
  readonly uploaded: string[]
  /** Each commit the page sent: the path, and the file body that went with it. */
  readonly committed: { path: string; file: string }[]
}

interface Stubs {
  /** Ids handed back by successive uploads. The first is the first upload. */
  readonly jobIds?: readonly string[]
  /** Fails the nth upload, counting from 1, the way an unusable column map does. */
  readonly failUpload?: number
  /** Warnings the dry run answers with, e.g. a person whose company was absent. */
  readonly warnings?: readonly { row: number; field: string; message: string }[]
}

function dataClient(stubs: Stubs, harness: Harness): ApiClient {
  const ids = stubs.jobIds ?? ['imp_a', 'imp_b']

  return stubClient({
    get: (path) => {
      if (!path.startsWith('/import/jobs/')) {
        throw new Error(`Unexpected get ${path}`)
      }

      return wireJob(path.replace('/import/jobs/', ''))
    },
    postForm: async (path, form) => {
      if (path.endsWith('/commit')) {
        const sent = form.get('file')

        harness.committed.push({
          path,
          file: sent instanceof File ? await sent.text() : String(sent),
        })

        return { ...wireJob(path.split('/')[3] ?? ''), status: 'completed' }
      }

      if (path !== '/import/jobs') {
        throw new Error(`Unexpected postForm ${path}`)
      }

      harness.uploaded.push(ids[harness.uploaded.length] ?? 'imp_overflow')

      if (harness.uploaded.length === stubs.failUpload) {
        return Promise.reject(
          new ApiError(422, 'validation_failed', 'That column map cannot read this file', []),
        )
      }

      return wireJob(harness.uploaded[harness.uploaded.length - 1] ?? '', {
        warnings: stubs.warnings ?? [],
      })
    },
    delete: (path) => {
      harness.deleted.push(path)
    },
  })
}

function renderPage(stubs: Stubs = {}): Harness {
  const harness: Harness = { deleted: [], uploaded: [], committed: [] }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <MemoryRouter>
      <ApiProvider client={dataClient(stubs, harness)} queryClient={queryClient}>
        <DataPage />
      </ApiProvider>
    </MemoryRouter>,
  )

  return harness
}

const CSV = 'name,domain\nAcme,acme.com'

/** Walks the wizard from the source step to a job on the mapping step. */
async function uploadFile(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  const input = await screen.findByLabelText(/Drop a CSV here/u)

  fireEvent.change(input, { target: { files: [new File([CSV], 'companies.csv')] } })

  await screen.findByRole('button', { name: 'Run dry-run' })
}

describe('DataPage import wizard', () => {
  it('deletes the superseded job when a corrected mapping replaces it', async () => {
    const harness = renderPage()

    await uploadFile()
    fireEvent.click(screen.getByRole('button', { name: 'Run dry-run' }))

    await waitFor(() => {
      expect(harness.deleted).toEqual(['/import/jobs/imp_a'])
    })

    // And not the replacement, which is the job the caller is now looking at.
    expect(harness.uploaded).toEqual(['imp_a', 'imp_b'])
  })

  it('keeps the superseded job when the corrected mapping is refused', async () => {
    const harness = renderPage({ failUpload: 2 })

    await uploadFile()
    fireEvent.click(screen.getByRole('button', { name: 'Run dry-run' }))

    // The caller is still on the mapping table, reading the headers this job
    // carries, and has to correct the map again.
    await screen.findByText(/That column map cannot read this file/u)
    expect(harness.deleted).toEqual([])
  })

  it('deletes the job when the wizard starts over', async () => {
    const harness = renderPage()

    await uploadFile()
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))

    await waitFor(() => {
      expect(harness.deleted).toEqual(['/import/jobs/imp_a'])
    })
  })

  /**
   * The server keeps the digest of the file it forecast, not the file. The
   * wizard has held the `File` since the upload, and this is what it is for.
   */
  it('sends the file back with the commit', async () => {
    const harness = renderPage()

    await uploadFile()
    fireEvent.click(screen.getByRole('button', { name: 'Run dry-run' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit import/u }))

    await waitFor(() => {
      expect(harness.committed).toEqual([
        { path: '/import/jobs/imp_b/commit', file: CSV },
      ])
    })
  })

  it('deletes the job when the caller steps back to pick another file', async () => {
    const harness = renderPage()

    await uploadFile()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    await waitFor(() => {
      expect(harness.deleted).toEqual(['/import/jobs/imp_a'])
    })
  })

  it('offers the missing-company choice for a People import, not for companies', async () => {
    renderPage()

    await uploadFile()
    expect(screen.queryByText('Missing company')).toBeNull()

    // Start over and pick People. The import Object select is the third
    // combobox: export object, then the source step's source and object.
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    fireEvent.change(screen.getAllByRole('combobox')[2] as HTMLSelectElement, {
      target: { value: 'people' },
    })
    await uploadFile()

    expect(screen.getByText('Missing company')).toBeTruthy()
  })

  it('lists warnings on rows that were imported anyway', async () => {
    renderPage({
      warnings: [{ row: 2, field: 'company_domain', message: 'No company here matches "beta.io"' }],
    })

    await uploadFile()
    fireEvent.click(screen.getByRole('button', { name: 'Run dry-run' }))

    await screen.findByText('Warnings')
    expect(screen.getByText(/No company here matches/u)).toBeTruthy()
  })
})
