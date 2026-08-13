import { handbookPageSchema } from '@kelpie/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { STARTER_HANDBOOK_PAGES } from '../workspace/starters.ts'
import { handbookPages } from './schema.ts'

/**
 * `/v1/handbook_pages` against real Postgres: the pages, the tree they sit in,
 * and the two rules a self-referencing foreign key cannot enforce.
 */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('handbook', () => {
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
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()
  })

  async function createPage(
    body: Record<string, unknown> = {},
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/handbook_pages', {
      body: { title: 'Case studies', ...body },
      cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  /** A page's id, for the many tests that only need the handle. */
  async function createPageId(body: Record<string, unknown> = {}): Promise<string> {
    return readString(await createPage(body), 'id')
  }

  async function patchPage(
    id: string,
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Response> {
    return client.send('PATCH', `/v1/handbook_pages/${id}`, { body, cookie })
  }

  async function listPages(query = ''): Promise<Record<string, unknown>[]> {
    const response = await client.send('GET', `/v1/handbook_pages${query}`, { cookie: acme.cookie })

    expect(response.status).toBe(200)

    return readList(await response.json())
  }

  /** A chain `depth` levels below the top, returned top first. */
  async function createChain(depth: number): Promise<string[]> {
    const ids: string[] = []
    let parentId: string | null = null

    for (let level = 0; level <= depth; level += 1) {
      const id: string = await createPageId({ title: `Level ${String(level)}`, parent_id: parentId })

      ids.push(id)
      parentId = id
    }

    return ids
  }

  /** The sibling order the tree is actually in, read back from the database. */
  async function siblingOrder(parentId: string | null): Promise<[string, number][]> {
    const rows = await database.db
      .select()
      .from(handbookPages)
      .where(eq(handbookPages.workspaceId, acme.workspaceId))

    return rows
      .filter((row) => row.parentId === parentId)
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((row): [string, number] => [row.title, row.sortOrder])
  }

  describe('seeding', () => {
    /**
     * Sorted by `sort_order`, not by `created_at`. The ten rows are inserted in
     * one transaction, so Postgres stamps them all with the same `now()`, and the
     * keyset tiebreak falls to a ULID whose entropy is not monotonic within a
     * millisecond. Seeding order lives in `sort_order` and nowhere else, which is
     * the same reason the sidebar reads that column.
     */
    it('opens a new workspace on the ten starter pages, in order, at the top level', async () => {
      const pages = (await listPages('?limit=200')).sort(
        (left, right) => Number(left.sort_order) - Number(right.sort_order),
      )

      expect(pages).toHaveLength(STARTER_HANDBOOK_PAGES.length)
      expect(pages.map((page) => page.title)).toEqual(
        STARTER_HANDBOOK_PAGES.map((starter) => starter.title),
      )
      expect(pages.map((page) => page.slug)).toEqual(
        STARTER_HANDBOOK_PAGES.map((starter) => starter.slug),
      )
      expect(pages.map((page) => page.sort_order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(pages.every((page) => page.parent_id === null)).toBe(true)
    })

    it('stamps the seeded pages with the owner who created the workspace', async () => {
      const [first] = await listPages('?limit=1')

      expect(first?.updated_by).toMatch(/^mem_/u)
    })
  })

  describe('pages', () => {
    it('creates a top-level page with a slug derived from its title', async () => {
      const page = await createPage()

      expect(page.id).toMatch(/^hb_/u)
      expect(page.title).toBe('Case studies')
      expect(page.slug).toBe('case-studies')
      expect(page.parent_id).toBeNull()
      expect(page.body).toBe('')
      expect(page.updated_by).toMatch(/^mem_/u)
    })

    it('answers a shape the published schema parses', async () => {
      const page = await createPage()
      const listed = await listPages('?limit=200')

      expect(() => handbookPageSchema.parse(page)).not.toThrow()
      expect(() => listed.map((item) => handbookPageSchema.parse(item))).not.toThrow()
    })

    it('takes a body and a hand-written slug', async () => {
      const page = await createPage({
        title: 'How we price',
        body: '# Pricing\n\nPer seat.',
        slug: 'pricing-2026',
      })

      expect(page.slug).toBe('pricing-2026')
      expect(page.body).toBe('# Pricing\n\nPer seat.')
    })

    it('suffixes a derived slug that is taken rather than refusing the title', async () => {
      const first = await createPage({ title: 'Pricing notes' })
      const second = await createPage({ title: 'Pricing notes' })

      expect(first.slug).toBe('pricing-notes')
      expect(second.slug).toBe('pricing-notes-2')
    })

    it('refuses a hand-written slug already in use with 409', async () => {
      await createPage({ title: 'Pricing notes', slug: 'launch' })

      const response = await client.send('POST', '/v1/handbook_pages', {
        body: { title: 'Something else', slug: 'launch' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(409)
      expect(readRecord(await response.json())).toMatchObject({
        error: { code: 'conflict', details: [{ field: 'slug' }] },
      })
    })

    it('refuses a slug moved onto one another page already holds with 409', async () => {
      const id = await createPageId({ title: 'Pricing notes' })

      expect((await patchPage(id, { slug: 'about-us' })).status).toBe(409)
    })

    it('edits the title and body, stamping who wrote it and when', async () => {
      const page = await createPage()
      const id = readString(page, 'id')
      const response = await patchPage(id, { title: 'Customer stories', body: 'One so far.' })
      const updated = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(updated.title).toBe('Customer stories')
      expect(updated.body).toBe('One so far.')
      expect(updated.updated_by).toMatch(/^mem_/u)
      expect(String(updated.updated_at) > String(page.updated_at)).toBe(true)
    })

    it('leaves the slug alone when the title is renamed', async () => {
      const id = await createPageId({ title: 'Case studies' })
      const response = await patchPage(id, { title: 'Customer stories' })

      expect(readRecord(await response.json()).slug).toBe('case-studies')
    })

    it('writes nothing when nothing changes', async () => {
      const page = await createPage()
      const response = await patchPage(readString(page, 'id'), { title: 'Case studies' })

      expect(readRecord(await response.json()).updated_at).toBe(page.updated_at)
    })

    it('finds pages by their words and by their slug', async () => {
      const id = await createPageId({
        title: 'Case studies',
        body: 'Northwind halved onboarding time.',
        slug: 'case-studies',
      })

      const byTitle = await listPages('?q=case')
      const byBody = await listPages('?q=northwind')
      const bySlug = await listPages('?slug=case-studies')
      const byNothing = await listPages('?q=zeppelin')

      expect(byTitle.map((page) => page.id)).toEqual([id])
      expect(byBody.map((page) => page.id)).toEqual([id])
      expect(bySlug.map((page) => page.id)).toEqual([id])
      expect(byNothing).toHaveLength(0)
    })

    it('names a set of slugs in one request, the way an agent task does', async () => {
      const pages = await listPages('?slug=ideal-customer-profile&slug=agent-faq')

      expect(pages.map((page) => page.slug).sort()).toEqual(['agent-faq', 'ideal-customer-profile'])
    })

    it('sorts alphabetically by default, because a handbook is read rather than triaged', async () => {
      const titles = (await listPages('?limit=200')).map((page) => page.title)

      expect(titles).toEqual([...titles].sort())
      expect(titles[0]).toBe('About us')
    })

    it('refuses malformed values with 422', async () => {
      const cases: Record<string, unknown>[] = [
        {},
        { title: '' },
        { title: 'X', slug: 'Not A Slug' },
        { title: 'X', slug: '' },
        { title: 'X', parent_id: '' },
        { title: 'X', published: true },
      ]

      for (const body of cases) {
        const response = await client.send('POST', '/v1/handbook_pages', {
          body,
          cookie: acme.cookie,
        })

        expect(response.status).toBe(422)
      }

      const id = await createPageId()

      expect((await patchPage(id, { sort_order: -1 })).status).toBe(422)
    })

    it('needs credentials', async () => {
      expect((await client.send('GET', '/v1/handbook_pages')).status).toBe(401)
      expect(
        (await client.send('POST', '/v1/handbook_pages', { body: { title: 'X' } })).status,
      ).toBe(401)
    })

    it('keeps workspaces apart', async () => {
      const id = await createPageId()
      const other = await client.owner('grace@example.com', 'other')

      const get = await client.send('GET', `/v1/handbook_pages/${id}`, { cookie: other.cookie })
      const patch = await patchPage(id, { title: 'Theirs now' }, other.cookie)
      const remove = await client.send('DELETE', `/v1/handbook_pages/${id}`, {
        cookie: other.cookie,
      })
      const theirs = await client.send('GET', '/v1/handbook_pages?q=case', { cookie: other.cookie })

      expect(get.status).toBe(404)
      expect(patch.status).toBe(404)
      expect(remove.status).toBe(404)
      expect(readList(await theirs.json())).toHaveLength(0)
    })

    it('lets two workspaces hold the same slug', async () => {
      await createPage({ title: 'Case studies' })
      const other = await client.owner('grace@example.com', 'other')

      const response = await client.send('POST', '/v1/handbook_pages', {
        body: { title: 'Case studies' },
        cookie: other.cookie,
      })

      expect(response.status).toBe(201)
      expect(readRecord(await response.json()).slug).toBe('case-studies')
    })
  })

  describe('the tree', () => {
    it('nests a page under another, at the end of its siblings', async () => {
      const parentId = await createPageId({ title: 'Product' })
      const first = await createPage({ title: 'Roadmap', parent_id: parentId })
      const second = await createPage({ title: 'Changelog', parent_id: parentId })

      expect(first.parent_id).toBe(parentId)
      expect(first.sort_order).toBe(0)
      expect(second.sort_order).toBe(1)
    })

    it('reorders siblings, renumbering the set contiguously from zero', async () => {
      const parentId = await createPageId({ title: 'Product' })
      const roadmap = await createPageId({ title: 'Roadmap', parent_id: parentId })
      await createPageId({ title: 'Changelog', parent_id: parentId })
      await createPageId({ title: 'Support', parent_id: parentId })

      expect((await patchPage(roadmap, { sort_order: 2 })).status).toBe(200)
      expect(await siblingOrder(parentId)).toEqual([
        ['Changelog', 0],
        ['Support', 1],
        ['Roadmap', 2],
      ])
    })

    it('re-nests a page and closes the gap it left behind', async () => {
      const productId = await createPageId({ title: 'Product' })
      const salesId = await createPageId({ title: 'Sales' })
      await createPageId({ title: 'Roadmap', parent_id: productId })
      const changelogId = await createPageId({ title: 'Changelog', parent_id: productId })
      await createPageId({ title: 'Support', parent_id: productId })

      const response = await patchPage(changelogId, { parent_id: salesId, sort_order: 0 })

      expect(readRecord(await response.json())).toMatchObject({ parent_id: salesId, sort_order: 0 })
      expect(await siblingOrder(productId)).toEqual([
        ['Roadmap', 0],
        ['Support', 1],
      ])
      expect(await siblingOrder(salesId)).toEqual([['Changelog', 0]])
    })

    it('lifts a page to the top level with a null parent', async () => {
      const parentId = await createPageId({ title: 'Product' })
      const childId = await createPageId({ title: 'Roadmap', parent_id: parentId })

      const response = await patchPage(childId, { parent_id: null })

      expect(readRecord(await response.json()).parent_id).toBeNull()
    })

    it('carries the subpages along when a page is re-nested', async () => {
      const [top, middle] = await createChain(1)
      const elsewhere = await createPageId({ title: 'Elsewhere' })

      expect((await patchPage(String(top), { parent_id: elsewhere })).status).toBe(200)

      const pages = await listPages('?limit=200')
      const child = pages.find((page) => page.id === middle)

      expect(child?.parent_id).toBe(top)
    })

    it('refuses a page under itself', async () => {
      const id = await createPageId()
      const response = await patchPage(id, { parent_id: id })

      expect(response.status).toBe(422)
      expect(readRecord(await response.json())).toMatchObject({
        error: { code: 'validation_failed', details: [{ field: 'parent_id' }] },
      })
    })

    it('refuses a page under one of its own subpages', async () => {
      const [top, , grandchild] = await createChain(2)

      expect((await patchPage(String(top), { parent_id: String(grandchild) })).status).toBe(422)
    })

    it('refuses a parent that is not in this workspace', async () => {
      const id = await createPageId()
      const other = await client.owner('grace@example.com', 'other')
      const theirs = readString(
        await createPage({ title: 'Theirs' }, other.cookie),
        'id',
      )

      expect((await patchPage(id, { parent_id: theirs })).status).toBe(422)
      expect(
        (
          await client.send('POST', '/v1/handbook_pages', {
            body: { title: 'X', parent_id: theirs },
            cookie: acme.cookie,
          })
        ).status,
      ).toBe(422)
    })

    it('nests five levels and refuses a sixth', async () => {
      const chain = await createChain(4)

      expect(chain).toHaveLength(5)

      const response = await client.send('POST', '/v1/handbook_pages', {
        body: { title: 'Too deep', parent_id: chain.at(-1) },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    /**
     * The branch is two pages tall, so its leaf lands two levels below whatever
     * it is hung off. Under the chain's depth-3 page that leaf would be depth 5;
     * under its depth-2 page it is depth 4, which is the last one there is. The
     * page being moved fits inside the cap in both cases, which is the point:
     * the check counts what the page carries, not only where it lands.
     */
    it('refuses a move that would push a page’s own subpages past the cap', async () => {
      const chain = await createChain(3)
      const branchTop = await createPageId({ title: 'Branch' })
      await createPageId({ title: 'Branch leaf', parent_id: branchTop })

      expect((await patchPage(branchTop, { parent_id: String(chain[3]) })).status).toBe(422)
      expect((await patchPage(branchTop, { parent_id: String(chain[2]) })).status).toBe(200)
    })

    it('does not stamp a page as edited because a neighbour moved', async () => {
      const parentId = await createPageId({ title: 'Product' })
      const roadmap = await createPage({ title: 'Roadmap', parent_id: parentId })
      const changelog = await createPageId({ title: 'Changelog', parent_id: parentId })

      await patchPage(changelog, { sort_order: 0 })

      const moved = await listPages('?q=roadmap')

      expect(moved[0]?.updated_at).toBe(roadmap.updated_at)
    })
  })

  describe('deleting', () => {
    it('deletes a page and every page nested under it', async () => {
      const chain = await createChain(2)
      const survivor = await createPageId({ title: 'Survivor' })

      const response = await client.send('DELETE', `/v1/handbook_pages/${String(chain[0])}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(204)

      const remaining = (await listPages('?limit=200')).map((page) => page.id)

      expect(remaining).toContain(survivor)
      for (const id of chain) {
        expect(remaining).not.toContain(id)
      }
    })

    it('closes the gap the deleted page left among its siblings', async () => {
      const parentId = await createPageId({ title: 'Product' })
      await createPageId({ title: 'Roadmap', parent_id: parentId })
      const changelogId = await createPageId({ title: 'Changelog', parent_id: parentId })
      await createPageId({ title: 'Support', parent_id: parentId })

      await client.send('DELETE', `/v1/handbook_pages/${changelogId}`, { cookie: acme.cookie })

      expect(await siblingOrder(parentId)).toEqual([
        ['Roadmap', 0],
        ['Support', 1],
      ])
    })

    it('answers 404 for a page that is already gone', async () => {
      const id = await createPageId()

      await client.send('DELETE', `/v1/handbook_pages/${id}`, { cookie: acme.cookie })

      const again = await client.send('DELETE', `/v1/handbook_pages/${id}`, { cookie: acme.cookie })

      expect(again.status).toBe(404)
    })

    it('frees the deleted page’s slug for reuse', async () => {
      const id = await createPageId({ title: 'Case studies' })

      await client.send('DELETE', `/v1/handbook_pages/${id}`, { cookie: acme.cookie })

      expect((await createPage({ title: 'Case studies' })).slug).toBe('case-studies')
    })
  })
})
