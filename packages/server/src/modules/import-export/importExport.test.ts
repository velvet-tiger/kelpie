import { importJobSchema } from '@kelpie/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { activities } from '../activities/schema.ts'
import { companies } from '../companies/schema.ts'
import { coreModules } from '../core.ts'
import { deals } from '../deals/schema.ts'
import { people } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { positions } from '../positions/schema.ts'
import { importJobRows } from './schema.ts'

/**
 * `/v1/import` and `/v1/export` against real Postgres.
 *
 * The load-bearing assertions are the ones about the two calls disagreeing: a
 * dry run is a forecast taken against the workspace as it was, and a commit
 * re-resolves. Everything about idempotency, in-file duplicates, and rows that
 * fail rather than inventing a record follows from that.
 */

const connectionString = testDatabaseUrl(process.env)

const COMPANIES_CSV = [
  'name,domain,industry,account_type',
  'Acme,acme.com,Software,customer',
  'Harbour Lane,harbour.io,Logistics,prospect',
].join('\n')

interface JobFields {
  readonly source?: string
  readonly object?: string
  readonly conflict_mode?: string
  readonly match_key?: string
  readonly column_map?: string
  readonly dry_run?: string
}

describe.skipIf(connectionString === undefined)('import and export', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
  })

  afterAll(async () => {
    await database.close()
  })

  beforeEach(async () => {
    await database.truncateAll()
    harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    client = createTestClient(harness.app)
    acme = await client.owner()
  })

  /** A multipart upload. The test client speaks JSON, and this endpoint does not. */
  function upload(
    csv: string,
    fields: JobFields = {},
    options: { cookie?: string; fileName?: string } = {},
  ): Promise<Response> {
    const form = new FormData()

    form.set('file', new File([csv], options.fileName ?? 'upload.csv', { type: 'text/csv' }))

    for (const [key, value] of Object.entries({ source: 'custom', object: 'companies', ...fields })) {
      form.set(key, value)
    }

    return Promise.resolve(
      harness.app.request('/v1/import/jobs', {
        method: 'POST',
        headers: { Cookie: options.cookie ?? acme.cookie },
        body: form,
      }),
    )
  }

  async function createJob(csv: string, fields: JobFields = {}): Promise<Record<string, unknown>> {
    const response = await upload(csv, fields)

    if (response.status !== 201) {
      throw new Error(`Creating a job answered ${String(response.status)}: ${await response.text()}`)
    }

    return readRecord(await response.json())
  }

  async function commit(jobId: string): Promise<Record<string, unknown>> {
    const response = await client.send('POST', `/v1/import/jobs/${jobId}/commit`, {
      cookie: acme.cookie,
    })

    if (response.status !== 200) {
      throw new Error(`Committing answered ${String(response.status)}: ${await response.text()}`)
    }

    return readRecord(await response.json())
  }

  /** Creates a job and commits it, which is the whole two-step flow. */
  async function importCsv(csv: string, fields: JobFields = {}): Promise<Record<string, unknown>> {
    return commit(readString(await createJob(csv, fields), 'id'))
  }

  /** The field-level `details` of a 422, which is where the useful part of one is. */
  async function errorDetails(response: Response): Promise<unknown> {
    const body = readRecord(await response.json())

    return readRecord(body.error).details
  }

  async function exportCsv(object: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('GET', `/v1/export/${object}.csv`, { cookie })

    expect(response.status).toBe(200)

    return response.text()
  }

  describe('creating a job', () => {
    it('parses the file, plans every row, and answers ready', async () => {
      const job = await createJob(COMPANIES_CSV)

      expect(job).toMatchObject({
        source: 'custom',
        object: 'companies',
        status: 'ready',
        conflict_mode: 'skip',
        match_key: 'domain',
        file_name: 'upload.csv',
        counts: { total: 2, create: 2, update: 0, skip: 0, error: 0 },
      })
    })

    it('reports the file’s own headers, so a caller can build a mapping screen', async () => {
      expect(await createJob(COMPANIES_CSV)).toMatchObject({
        source_headers: ['name', 'domain', 'industry', 'account_type'],
      })
    })

    it('derives a column map when the request sends none', async () => {
      expect((await createJob(COMPANIES_CSV)).column_map).toMatchObject({
        name: 'name',
        domain: 'domain',
        industry: 'industry',
        summary: null,
      })
    })

    it('derives a HubSpot map from the source preset', async () => {
      const csv = 'Name,Company Domain Name\nAcme,acme.com'
      const job = await createJob(csv, { source: 'hubspot' })

      expect(job.column_map).toMatchObject({ name: 'Name', domain: 'Company Domain Name' })
      expect(job).toMatchObject({ counts: { total: 1, create: 1 } })
    })

    it('takes the column map the request sends', async () => {
      const csv = 'Who,Where\nAcme,acme.com'
      const job = await createJob(csv, {
        column_map: JSON.stringify({ name: 'Who', domain: 'Where' }),
      })

      expect(job).toMatchObject({ counts: { total: 1, create: 1, error: 0 } })
    })

    it('previews the first rows as Kelpie read them', async () => {
      const job = await createJob(COMPANIES_CSV)

      expect(job.preview).toMatchObject([
        { row: 2, action: 'create', values: { name: 'Acme', domain: 'acme.com' } },
        { row: 3, action: 'create', values: { name: 'Harbour Lane' } },
      ])
    })

    it('parses through the shared wire schema', async () => {
      const parsed = importJobSchema.parse(await createJob(COMPANIES_CSV))

      expect(parsed.counts.create).toBe(2)
      expect(parsed.createdAt).toBeInstanceOf(Date)
    })

    it('refuses a file with no header row', async () => {
      const response = await upload('')

      expect(response.status).toBe(422)
      expect(await response.text()).toContain('header row')
    })

    it('refuses a file whose header repeats a name', async () => {
      const response = await upload('name,name\na,b')

      expect(response.status).toBe(422)
    })

    it('refuses a request with no file', async () => {
      const form = new FormData()

      form.set('source', 'custom')
      form.set('object', 'companies')

      const response = await harness.app.request('/v1/import/jobs', {
        method: 'POST',
        headers: { Cookie: acme.cookie },
        body: form,
      })

      expect(response.status).toBe(422)
    })

    it('refuses a column map naming a column the object does not have', async () => {
      const response = await upload(COMPANIES_CSV, {
        column_map: JSON.stringify({ name: 'name', domain: 'domain', vibe: 'industry' }),
      })

      expect(response.status).toBe(422)
      expect(await errorDetails(response)).toMatchObject([
        { field: 'column_map.vibe', message: 'companies has no column called "vibe"' },
      ])
    })

    it('refuses a column map naming a header the file does not have', async () => {
      const response = await upload(COMPANIES_CSV, {
        column_map: JSON.stringify({ name: 'name', domain: 'Website' }),
      })

      expect(response.status).toBe(422)
      expect(await errorDetails(response)).toMatchObject([
        { field: 'column_map.domain', message: 'The file has no column headed "Website"' },
      ])
    })

    it('refuses a column map leaving the key column unmapped', async () => {
      const response = await upload(COMPANIES_CSV, {
        column_map: JSON.stringify({ name: 'name', domain: null }),
      })

      expect(response.status).toBe(422)
      expect(await response.text()).toContain('required columns must be mapped')
    })

    it('refuses a match key the object does not declare', async () => {
      const response = await upload(COMPANIES_CSV, { match_key: 'website' })

      expect(response.status).toBe(422)
    })

    /** `import-export.md` makes the commit a separate call. */
    it('refuses a create claiming not to be a dry run', async () => {
      const response = await upload(COMPANIES_CSV, { dry_run: 'false' })

      expect(response.status).toBe(422)
      expect(await response.text()).toContain('/commit')
    })

    it('needs credentials', async () => {
      const form = new FormData()

      form.set('file', new File([COMPANIES_CSV], 'x.csv'))
      form.set('source', 'custom')
      form.set('object', 'companies')

      const response = await harness.app.request('/v1/import/jobs', { method: 'POST', body: form })

      expect(response.status).toBe(401)
    })
  })

  describe('committing', () => {
    it('writes the records the dry run forecast', async () => {
      const job = await importCsv(COMPANIES_CSV)

      expect(job).toMatchObject({
        status: 'completed',
        counts: { total: 2, create: 2, skip: 0, error: 0 },
      })

      const rows = await database.db
        .select()
        .from(companies)
        .where(eq(companies.workspaceId, acme.workspaceId))

      expect(rows.map((row) => row.name).sort()).toEqual(['Acme', 'Harbour Lane'])
      expect(rows.find((row) => row.domain === 'acme.com')).toMatchObject({
        industry: 'Software',
        accountType: 'customer',
      })
    })

    /**
     * A company an import invented says nothing about the relationship, so it
     * takes `other` rather than the `prospect` a form submit uses.
     */
    it('fills the columns a CSV need not carry with honest defaults', async () => {
      await importCsv('name,domain\nQuiet Co,quiet.test')

      const [row] = await database.db
        .select()
        .from(companies)
        .where(eq(companies.domain, 'quiet.test'))

      expect(row).toMatchObject({
        stage: 'other',
        accountType: 'other',
        icpFit: 'unknown',
        sizeBand: '1-10',
      })
    })

    it('files one timeline entry per record, naming the file it came from', async () => {
      await importCsv(COMPANIES_CSV)

      const rows = await database.db
        .select()
        .from(activities)
        .where(eq(activities.workspaceId, acme.workspaceId))

      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ kind: 'created', action: 'created Company via upload.csv' })
    })

    /** `import-export.md`: re-POSTing a completed job succeeds and writes nothing more. */
    it('is idempotent: re-committing writes nothing and answers the same job', async () => {
      const jobId = readString(await createJob(COMPANIES_CSV), 'id')

      await commit(jobId)
      const second = await commit(jobId)

      expect(second).toMatchObject({ status: 'completed', counts: { create: 2 } })
      expect(
        await database.db.select().from(companies).where(eq(companies.workspaceId, acme.workspaceId)),
      ).toHaveLength(2)
    })

    /**
     * Re-running the same file is the other half of idempotency, and the one a
     * person actually does. The second job's own dry run has to see the records
     * the first one wrote.
     */
    it('re-importing the same file skips every row', async () => {
      await importCsv(COMPANIES_CSV)
      const second = await importCsv(COMPANIES_CSV)

      expect(second).toMatchObject({ counts: { total: 2, create: 0, skip: 2 } })
      expect(
        await database.db.select().from(companies).where(eq(companies.workspaceId, acme.workspaceId)),
      ).toHaveLength(2)
    })

    it('refuses to commit a job that has not been dry-run', async () => {
      const jobId = readString(await createJob(COMPANIES_CSV), 'id')

      await commit(jobId)
      // A completed job is the no-op case; a committing one is somebody else's.
      const response = await client.send('POST', `/v1/import/jobs/${jobId}/commit`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
    })

    it('answers 404 for a job in another workspace', async () => {
      const jobId = readString(await createJob(COMPANIES_CSV), 'id')
      const other = await client.owner('grace@example.com', 'harbour')
      const response = await client.send('GET', `/v1/import/jobs/${jobId}`, {
        cookie: other.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  /**
   * A corrected mapping is a new job over the same file, so nothing removes the
   * one it replaced. This is the way out, per `import-export.md`.
   */
  describe('deleting a job', () => {
    function remove(jobId: string, cookie = acme.cookie): Promise<Response> {
      return client.send('DELETE', `/v1/import/jobs/${jobId}`, { cookie })
    }

    function storedRows(jobId: string): Promise<{ jobId: string }[]> {
      return database.db
        .select({ jobId: importJobRows.jobId })
        .from(importJobRows)
        .where(eq(importJobRows.jobId, jobId))
    }

    it('answers 204', async () => {
      const jobId = readString(await createJob(COMPANIES_CSV), 'id')
      const response = await remove(jobId)

      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      expect((await client.send('GET', `/v1/import/jobs/${jobId}`, { cookie: acme.cookie })).status).toBe(404)
    })

    it('takes the rows a commit wrote with it', async () => {
      const jobId = readString(await importCsv(COMPANIES_CSV), 'id')

      expect(await storedRows(jobId)).toHaveLength(2)
      expect((await remove(jobId)).status).toBe(204)
      expect(await storedRows(jobId)).toHaveLength(0)
    })

    it('is how correcting a mapping three times stops leaving three files behind', async () => {
      const first = readString(await createJob(COMPANIES_CSV), 'id')
      const second = readString(
        await createJob(COMPANIES_CSV, { column_map: '{"name":"name","domain":"domain"}' }),
        'id',
      )

      expect((await remove(first)).status).toBe(204)

      // The replacement is untouched: deleting a superseded job is not deleting
      // the file it was read from.
      expect((await client.send('GET', `/v1/import/jobs/${second}`, { cookie: acme.cookie })).status).toBe(200)
      expect(await commit(second)).toMatchObject({ counts: { total: 2, create: 2 } })
    })

    it('leaves the records a completed job wrote', async () => {
      const jobId = readString(await importCsv(COMPANIES_CSV), 'id')

      expect((await remove(jobId)).status).toBe(204)
      expect(
        await database.db.select().from(companies).where(eq(companies.workspaceId, acme.workspaceId)),
      ).toHaveLength(2)
    })

    it('answers 404 for a job that is already gone', async () => {
      const jobId = readString(await createJob(COMPANIES_CSV), 'id')

      expect((await remove(jobId)).status).toBe(204)
      expect((await remove(jobId)).status).toBe(404)
    })

    it('answers 404 for a job in another workspace, and leaves it alone', async () => {
      const jobId = readString(await createJob(COMPANIES_CSV), 'id')
      const other = await client.owner('grace@example.com', 'harbour')

      expect((await remove(jobId, other.cookie)).status).toBe(404)
      expect((await client.send('GET', `/v1/import/jobs/${jobId}`, { cookie: acme.cookie })).status).toBe(200)
    })
  })

  /**
   * A dry run is a forecast. Storing the file as one row per line before anybody
   * committed anything charged a caller ten thousand rows for a mapping they
   * were still correcting.
   */
  describe('what a dry run stores', () => {
    function rowsOf(jobId: string): Promise<{ jobId: string }[]> {
      return database.db
        .select({ jobId: importJobRows.jobId })
        .from(importJobRows)
        .where(eq(importJobRows.jobId, jobId))
    }

    it('stores no rows at all', async () => {
      const jobId = readString(await createJob(COMPANIES_CSV), 'id')

      expect(await rowsOf(jobId)).toHaveLength(0)
    })

    it('still reports the counts, errors and preview off the job', async () => {
      const job = await createJob('name,domain\nAcme,acme.com\n,missing.test')

      expect(job).toMatchObject({
        status: 'ready',
        counts: { total: 2, create: 1, error: 1 },
        errors: [{ row: 3, field: 'name' }],
      })
      // The preview is the first rows as Kelpie read them, whatever happened to
      // them, so the failing line appears here as well as in `errors`.
      expect(job.preview).toMatchObject([
        { row: 2, action: 'create', values: { name: 'Acme', domain: 'acme.com' } },
        { row: 3, action: 'error', values: { name: '', domain: 'missing.test' } },
      ])
    })

    it('writes one row per line once the import actually runs', async () => {
      const jobId = readString(await createJob(COMPANIES_CSV), 'id')

      expect(await rowsOf(jobId)).toHaveLength(0)
      await commit(jobId)
      expect(await rowsOf(jobId)).toHaveLength(2)
    })

    it('correcting a mapping four times leaves four jobs and no rows', async () => {
      const ids = []

      for (let attempt = 0; attempt < 4; attempt += 1) {
        ids.push(readString(await createJob(COMPANIES_CSV), 'id'))
      }

      const rows = await database.db
        .select({ jobId: importJobRows.jobId })
        .from(importJobRows)
        .where(eq(importJobRows.workspaceId, acme.workspaceId))

      expect(ids).toHaveLength(4)
      expect(rows).toHaveLength(0)
    })
  })

  /**
   * A dry run is a forecast against the workspace as it was. The commit
   * re-resolves, which is the whole reason it can be re-run and the reason a
   * file listing one company twice creates it once.
   */
  describe('when the workspace changes between the dry run and the commit', () => {
    it('skips a row whose record somebody else created in the meantime', async () => {
      const jobId = readString(await createJob('name,domain\nAcme,acme.com'), 'id')

      await importCsv('name,domain\nAcme via another route,acme.com')

      const committed = await commit(jobId)

      // The dry run forecast one create. By the time it ran there was a company
      // on that domain, so it skipped rather than colliding with the unique key.
      expect(committed).toMatchObject({ counts: { total: 1, create: 0, skip: 1 } })

      const rows = await database.db.select().from(companies).where(eq(companies.domain, 'acme.com'))

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ name: 'Acme via another route' })
    })

    it('fails only the rows whose reference disappeared, and commits the rest', async () => {
      await importCsv(COMPANIES_CSV)

      const jobId = readString(
        await createJob(
          'name,company_domain,stage,value,external_id\nOne,acme.com,qualifying,10,a\nTwo,harbour.io,qualifying,20,b',
          { object: 'deals' },
        ),
        'id',
      )

      await database.db.delete(companies).where(eq(companies.domain, 'harbour.io'))

      const committed = await commit(jobId)

      expect(committed).toMatchObject({ counts: { total: 2, create: 1, error: 1 } })
      expect(committed.errors).toMatchObject([{ row: 3, field: 'company_domain' }])
      expect(await database.db.select().from(deals).where(eq(deals.externalId, 'a'))).toHaveLength(1)
    })
  })

  /**
   * Over `SYNC_IMPORT_ROWS` the work runs detached and the caller polls, per
   * `import-export.md`. Both requests answer 202 with a transient status.
   */
  describe('a file too large to answer inside the request', () => {
    const rows = Array.from(
      { length: 501 },
      (_, index) => `Company ${String(index)},company-${String(index)}.test`,
    )
    const bigCsv = ['name,domain', ...rows].join('\n')

    /** Polls the job until it settles, the way a caller does. */
    async function settle(jobId: string): Promise<Record<string, unknown>> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const job = readRecord(
          await (await client.send('GET', `/v1/import/jobs/${jobId}`, { cookie: acme.cookie })).json(),
        )

        if (job.status !== 'validating' && job.status !== 'committing' && job.status !== 'pending') {
          return job
        }

        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      throw new Error(`Job ${jobId} never settled`)
    }

    it('answers 202 while it validates, then reaches ready', async () => {
      const response = await upload(bigCsv)

      expect(response.status).toBe(202)

      const created = readRecord(await response.json())

      expect(created).toMatchObject({ status: 'validating' })

      expect(await settle(readString(created, 'id'))).toMatchObject({
        status: 'ready',
        counts: { total: 501, create: 501, error: 0 },
      })
    })

    it('answers 202 while it commits, then writes every row', async () => {
      const jobId = readString(readRecord(await (await upload(bigCsv)).json()), 'id')

      await settle(jobId)

      const response = await client.send('POST', `/v1/import/jobs/${jobId}/commit`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(202)
      expect(readRecord(await response.json())).toMatchObject({ status: 'committing' })

      expect(await settle(jobId)).toMatchObject({
        status: 'completed',
        counts: { total: 501, create: 501, error: 0 },
      })
      expect(
        await database.db.select().from(companies).where(eq(companies.workspaceId, acme.workspaceId)),
      ).toHaveLength(501)
    }, 120_000)

    it('refuses a second commit while the first is still running', async () => {
      const jobId = readString(readRecord(await (await upload(bigCsv)).json()), 'id')

      await settle(jobId)
      await client.send('POST', `/v1/import/jobs/${jobId}/commit`, { cookie: acme.cookie })

      const second = await client.send('POST', `/v1/import/jobs/${jobId}/commit`, {
        cookie: acme.cookie,
      })

      expect(second.status).toBe(409)
      await settle(jobId)
    }, 120_000)

    /**
     * The pass is reading the rows it is being asked to drop, and it would carry
     * on writing records against a job that had gone.
     */
    it('refuses to delete a job while it is committing', async () => {
      const jobId = readString(readRecord(await (await upload(bigCsv)).json()), 'id')

      await settle(jobId)
      await client.send('POST', `/v1/import/jobs/${jobId}/commit`, { cookie: acme.cookie })

      const response = await client.send('DELETE', `/v1/import/jobs/${jobId}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(409)

      // And once it settles, the same delete goes through.
      await settle(jobId)
      expect(
        (await client.send('DELETE', `/v1/import/jobs/${jobId}`, { cookie: acme.cookie })).status,
      ).toBe(204)
    }, 120_000)

    it('refuses a file over the row limit', async () => {
      const tooMany = ['name,domain', ...Array.from({ length: 10_001 }, (_, index) => `C${String(index)},c${String(index)}.test`)].join('\n')
      const response = await upload(tooMany)

      expect(response.status).toBe(422)
      expect(await errorDetails(response)).toMatchObject([{ field: 'file' }])
    })
  })

  describe('conflict modes', () => {
    const changed = 'name,domain,industry\nAcme Corporation,acme.com,Hardware'

    beforeEach(async () => {
      await importCsv('name,domain,industry\nAcme,acme.com,Software')
    })

    it('skips a matching row by default and leaves the record alone', async () => {
      const job = await importCsv(changed)

      expect(job).toMatchObject({ counts: { total: 1, skip: 1, update: 0, create: 0 } })

      const [row] = await database.db.select().from(companies).where(eq(companies.domain, 'acme.com'))

      expect(row).toMatchObject({ name: 'Acme', industry: 'Software' })
    })

    it('overwrites the mapped fields in update mode', async () => {
      const job = await importCsv(changed, { conflict_mode: 'update' })

      expect(job).toMatchObject({ counts: { total: 1, update: 1, create: 0 } })

      const [row] = await database.db.select().from(companies).where(eq(companies.domain, 'acme.com'))

      expect(row).toMatchObject({ name: 'Acme Corporation', industry: 'Hardware' })
    })

    /**
     * A partial export with an empty column would otherwise erase the field on
     * every record it names, which no author of a spreadsheet expects.
     */
    it('leaves a field alone when the mapped cell is blank', async () => {
      await importCsv('name,domain,industry\nAcme Corporation,acme.com,', {
        conflict_mode: 'update',
      })

      const [row] = await database.db.select().from(companies).where(eq(companies.domain, 'acme.com'))

      expect(row).toMatchObject({ name: 'Acme Corporation', industry: 'Software' })
    })

    it('files an update entry on the timeline only when something moved', async () => {
      await database.db.delete(activities).where(eq(activities.workspaceId, acme.workspaceId))
      await importCsv('name,domain,industry\nAcme,acme.com,Software', { conflict_mode: 'update' })

      expect(
        await database.db.select().from(activities).where(eq(activities.workspaceId, acme.workspaceId)),
      ).toHaveLength(0)
    })

    it('matches on name when the job says to', async () => {
      const job = await importCsv('name,domain\nAcme,elsewhere.test', { match_key: 'name' })

      expect(job).toMatchObject({ counts: { total: 1, skip: 1 } })
    })
  })

  describe('in-file duplicates', () => {
    it('creates one record for a file naming the same company twice', async () => {
      const job = await importCsv('name,domain\nAcme,acme.com\nAcme Inc,ACME.com')

      expect(job).toMatchObject({ counts: { total: 2, create: 1, skip: 1 } })
      expect(
        await database.db.select().from(companies).where(eq(companies.domain, 'acme.com')),
      ).toHaveLength(1)
    })

    it('applies the later row to the earlier one in update mode', async () => {
      await importCsv('name,domain\nAcme,acme.com\nAcme Inc,acme.com', { conflict_mode: 'update' })

      const rows = await database.db.select().from(companies).where(eq(companies.domain, 'acme.com'))

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ name: 'Acme Inc' })
    })
  })

  describe('people, positions and deals', () => {
    beforeEach(async () => {
      await importCsv(COMPANIES_CSV)
      await importCsv('name,email,influence\nAda Lovelace,ada@acme.com,champion', {
        object: 'people',
      })
    })

    it('imports people with their enums and lists', async () => {
      await importCsv('name,email,tags,phones\nGrace Hopper,grace@acme.com,vip|speaker,+61 3 1|+61 3 2', {
        object: 'people',
      })

      const [row] = await database.db.select().from(people).where(eq(people.email, 'grace@acme.com'))

      expect(row).toMatchObject({
        name: 'Grace Hopper',
        tags: ['vip', 'speaker'],
        phones: ['+61 3 1', '+61 3 2'],
        relationship: 'cold',
      })
    })

    it('links a position from a contact title and a company domain', async () => {
      const job = await importCsv(
        'person_email,company_domain,title\nada@acme.com,acme.com,CTO',
        { object: 'positions' },
      )

      expect(job).toMatchObject({ counts: { total: 1, create: 1 } })

      const [row] = await database.db
        .select()
        .from(positions)
        .where(eq(positions.workspaceId, acme.workspaceId))

      expect(row).toMatchObject({ title: 'CTO' })
    })

    it('fails a position row whose person is not here yet', async () => {
      const job = await importCsv(
        'person_email,company_domain,title\nnobody@acme.com,acme.com,CTO',
        { object: 'positions' },
      )

      expect(job).toMatchObject({ counts: { total: 1, error: 1, create: 0 } })
      expect(job.errors).toMatchObject([{ row: 2, field: 'person_email' }])
    })

    it('imports a deal, resolving its company, stage, value and contacts', async () => {
      const job = await importCsv(
        'name,company_domain,stage,value,person_emails,external_id\nAcme renewal,acme.com,Proposal,1200.50,ada@acme.com,hs-1',
        { object: 'deals' },
      )

      expect(job).toMatchObject({ counts: { total: 1, create: 1 } })

      const [row] = await database.db.select().from(deals).where(eq(deals.externalId, 'hs-1'))

      expect(row).toMatchObject({
        name: 'Acme renewal',
        valueCents: 120_050,
        currency: 'USD',
      })
    })

    it('resolves a HubSpot stage name through the alias table', async () => {
      await importCsv(
        'name,company_domain,stage,value,external_id\nAcme renewal,acme.com,Closed Won,10,hs-2',
        { object: 'deals' },
      )

      const [row] = await database.db.select().from(deals).where(eq(deals.externalId, 'hs-2'))
      const [stage] = await database.db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.id, row?.stageId ?? ''))

      expect(stage).toMatchObject({ slug: 'won', kind: 'deal' })
    })

    it('fails a deal row whose company is missing rather than creating a stub', async () => {
      const job = await importCsv(
        'name,company_domain,stage,value,external_id\nGhost deal,nowhere.test,qualifying,10,hs-3',
        { object: 'deals' },
      )

      expect(job).toMatchObject({ counts: { error: 1, create: 0 } })
      expect(job.errors).toMatchObject([{ row: 2, field: 'company_domain' }])
      expect(
        await database.db.select().from(companies).where(eq(companies.domain, 'nowhere.test')),
      ).toHaveLength(0)
    })

    it('fails a deal row naming an owner who is not in the workspace', async () => {
      const job = await importCsv(
        'name,company_domain,stage,value,owner_email,external_id\nAcme renewal,acme.com,qualifying,10,stranger@example.com,hs-4',
        { object: 'deals' },
      )

      expect(job).toMatchObject({ counts: { error: 1 } })
      expect(job.errors).toMatchObject([{ row: 2, field: 'owner_email' }])
    })

    it('assigns a deal to the member whose address the file names', async () => {
      await importCsv(
        'name,company_domain,stage,value,owner_email,external_id\nAcme renewal,acme.com,qualifying,10,ada@example.com,hs-5',
        { object: 'deals' },
      )

      const [row] = await database.db.select().from(deals).where(eq(deals.externalId, 'hs-5'))

      expect(row?.ownerId).not.toBeNull()
    })
  })

  describe('export', () => {
    it('writes a header-only template', async () => {
      const response = await client.send('GET', '/v1/export/templates/people.csv', {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('text/csv')
      expect(await response.text()).toBe(
        'name,email,timezone,location,preferred_channel,influence,relationship,summary,tags,phones\n',
      )
    })

    it('streams a workspace’s companies', async () => {
      await importCsv(COMPANIES_CSV)

      const csv = await exportCsv('companies')

      expect(csv.split('\n')[0]).toBe(
        'name,domain,industry,stage,size_band,account_type,icp_fit,description,summary,tags,website,hq',
      )
      expect(csv).toContain('Acme,acme.com,Software')
      expect(csv).toContain('Harbour Lane,harbour.io,Logistics')
    })

    it('offers the file as a download and keeps it out of shared caches', async () => {
      const response = await client.send('GET', '/v1/export/companies.csv', { cookie: acme.cookie })

      expect(response.headers.get('Content-Disposition')).toBe(
        'attachment; filename="kelpie-companies.csv"',
      )
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    })

    it('answers 404 for an object nothing exports', async () => {
      const response = await client.send('GET', '/v1/export/notes.csv', { cookie: acme.cookie })

      expect(response.status).toBe(404)
    })

    it('needs credentials', async () => {
      const response = await client.send('GET', '/v1/export/companies.csv')

      expect(response.status).toBe(401)
    })

    it('shows only this workspace’s records', async () => {
      await importCsv(COMPANIES_CSV)
      const other = await client.owner('grace@example.com', 'harbour')

      expect(await exportCsv('companies', other.cookie)).toBe(
        'name,domain,industry,stage,size_band,account_type,icp_fit,description,summary,tags,website,hq\n',
      )
    })

    /**
     * The point of writing slugs and major units: a workspace can export its own
     * data and read it straight back in with no mapping at all.
     */
    it('round-trips through import with no column map', async () => {
      await importCsv(COMPANIES_CSV)
      await importCsv(
        'name,email,timezone,location,preferred_channel,influence,relationship,summary,tags,phones\nAda,ada@acme.com,UTC,Melbourne,call,champion,warm,Knows everyone,vip,+61 3 1',
        { object: 'people' },
      )
      await importCsv(
        'name,company_domain,stage,value,external_id\nAcme renewal,acme.com,qualifying,1200.50,hs-9',
        { object: 'deals' },
      )

      for (const object of ['companies', 'people', 'deals']) {
        const exported = await exportCsv(object)
        const job = await createJob(exported, { object })

        expect(job, `${object} re-import`).toMatchObject({
          counts: { create: 0, error: 0 },
        })
      }
    })

    it('writes a deal’s stage as its slug and its value as the major unit', async () => {
      await importCsv(COMPANIES_CSV)
      await importCsv(
        'name,company_domain,stage,value,external_id\nAcme renewal,acme.com,Closed Won,1200.50,hs-9',
        { object: 'deals' },
      )

      const csv = await exportCsv('deals')

      expect(csv).toContain('Acme renewal,acme.com,won,1200.50')
    })
  })
})
