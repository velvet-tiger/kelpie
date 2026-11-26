import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { API_KEY_SCOPES, satisfiesApiKeyScope } from '@kelpie/schemas'
import type { ApiKeyScope } from '@kelpie/schemas'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { coreMigrationsDirectory } from '../modules/core.ts'
import { connectTestDatabase, testDatabaseUrl } from '../testing/database.ts'
import type { TestDatabase } from '../testing/database.ts'
import { insertWorkspaceFixture } from '../testing/fixtures.ts'
import type { WorkspaceFixture } from '../testing/fixtures.ts'

/**
 * What migration 0068 does to the scope lists that were stored before it.
 *
 * Each test writes rows as they were before, runs the migration file as it is
 * on disk, and reads the result. Each test runs in a transaction that is rolled
 * back.
 */

/** Thrown to end the transaction once the rows have been read. Never a failure. */
class RolledBackOnPurpose extends Error {}

const MIGRATION = readFileSync(join(coreMigrationsDirectory, '0068_members_scopes.sql'), 'utf8').replaceAll(
  '--> statement-breakpoint',
  '',
)

type Transaction = Parameters<Parameters<TestDatabase['db']['transaction']>[0]>[0]

/** A scope list as it was stored before the migration. */
const CASES: readonly { readonly name: string; readonly before: readonly ApiKeyScope[] }[] = [
  { name: 'full', before: [] },
  { name: 'read', before: ['workspace:read'] },
  { name: 'write', before: ['workspace:write'] },
  { name: 'both', before: ['workspace:read', 'workspace:write'] },
  { name: 'already', before: ['workspace:read', 'members:read'] },
  { name: 'presets', before: ['read:all', 'write:admin'] },
  { name: 'unrelated', before: ['people:write', 'webhooks:read'] },
]

/** What each case must hold after the migration, sorted. An empty list stays empty. */
const AFTER: Readonly<Record<string, readonly string[]>> = {
  full: [],
  read: ['members:read', 'workspace:read'],
  write: ['members:write', 'workspace:write'],
  both: ['members:read', 'members:write', 'workspace:read', 'workspace:write'],
  already: ['members:read', 'workspace:read'],
  presets: ['read:all', 'write:admin'],
  unrelated: ['people:write', 'webhooks:read'],
}

const connectionString = testDatabaseUrl(process.env)

function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value)
}

describe.skipIf(connectionString === undefined)('the members scope migration', () => {
  let database: TestDatabase
  let fixture: WorkspaceFixture

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
    fixture = await insertWorkspaceFixture(database.db)
  })

  /** Runs `work` in a transaction that is rolled back, and hands back what it read. */
  async function inRolledBackTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    let result: { readonly value: T } | undefined

    try {
      await database.db.transaction(async (tx) => {
        result = { value: await work(tx) }

        throw new RolledBackOnPurpose()
      })
    } catch (thrown: unknown) {
      if (!(thrown instanceof RolledBackOnPurpose)) {
        throw thrown
      }
    }

    if (result === undefined) {
      throw new Error('The transaction ended before it read anything')
    }

    return result.value
  }

  function textArray(values: readonly string[]): ReturnType<typeof sql> {
    return sql`array[${sql.join(
      values.map((value) => sql`${value}`),
      sql`, `,
    )}]::text[]`
  }

  async function insertApiKeys(tx: Transaction): Promise<void> {
    for (const { name, before } of CASES) {
      await tx.execute(sql`
        insert into api_keys (id, workspace_id, name, secret_hash, display_prefix, scopes)
        values (${`apik_${name}`}, ${fixture.workspaceId}, ${name}, ${`hash_${name}`}, 'kp_live_…test', ${textArray(before)})
      `)
    }
  }

  /** One client, one connection, and for each case with scopes a grant and its three tokens. */
  async function insertOAuthRows(tx: Transaction): Promise<void> {
    await tx.execute(sql`
      insert into oauth_clients (id, client_id, kind, client_name, redirect_uris)
      values ('oac_test', 'oac_test', 'registered', 'Test Agent', array['http://127.0.0.1:1/cb'])
    `)
    await tx.execute(sql`
      insert into oauth_connections (id, user_id, client_row_id) values ('ocn_test', ${fixture.userId}, 'oac_test')
    `)

    for (const { name, before } of CASES.filter((entry) => entry.before.length > 0)) {
      const workspaceId = `ws_${name}`

      await tx.execute(sql`
        insert into workspaces (id, name, timezone) values (${workspaceId}, ${name}, 'Australia/Melbourne')
      `)
      await tx.execute(sql`
        insert into oauth_grants (id, workspace_id, user_id, client_row_id, connection_id, scopes)
        values (${`ogr_${name}`}, ${workspaceId}, ${fixture.userId}, 'oac_test', 'ocn_test', ${textArray(before)})
      `)

      for (const kind of ['code', 'access', 'refresh']) {
        await tx.execute(sql`
          insert into oauth_tokens (id, connection_id, kind, token_hash, resource, scopes, expires_at)
          values (
            ${`otk_${name}_${kind}`}, 'ocn_test', ${kind}, ${`hash_${name}_${kind}`},
            'https://kelpie.test/mcp', ${textArray(before)}, now() + interval '1 hour'
          )
        `)
      }
    }
  }

  /** Each row's scopes, sorted, keyed by row id. */
  async function readScopes(
    tx: Transaction,
    table: 'api_keys' | 'oauth_grants' | 'oauth_tokens',
  ): Promise<Record<string, string[]>> {
    const rows = await tx.execute<{ id: string; scopes: string[] }>(
      sql`select id, scopes from ${sql.identifier(table)} order by id`,
    )

    return Object.fromEntries([...rows].map((row) => [row.id, [...row.scopes].sort()]))
  }

  it('gives each API key the member scopes that match its workspace scopes', async () => {
    const after = await inRolledBackTransaction(async (tx) => {
      await insertApiKeys(tx)
      await tx.execute(sql.raw(MIGRATION))

      return readScopes(tx, 'api_keys')
    })

    expect(after).toEqual(Object.fromEntries(CASES.map((entry) => [`apik_${entry.name}`, [...AFTER[entry.name] ?? []]])))
  })

  it('does the same for each OAuth grant, authorization code, access token and refresh token', async () => {
    const after = await inRolledBackTransaction(async (tx) => {
      await insertOAuthRows(tx)
      await tx.execute(sql.raw(MIGRATION))

      return { grants: await readScopes(tx, 'oauth_grants'), tokens: await readScopes(tx, 'oauth_tokens') }
    })
    const withScopes = CASES.filter((entry) => entry.before.length > 0)

    expect(after.grants).toEqual(
      Object.fromEntries(withScopes.map((entry) => [`ogr_${entry.name}`, [...(AFTER[entry.name] ?? [])]])),
    )
    expect(after.tokens).toEqual(
      Object.fromEntries(
        withScopes.flatMap((entry) =>
          ['access', 'code', 'refresh'].map((kind) => [`otk_${entry.name}_${kind}`, [...(AFTER[entry.name] ?? [])]]),
        ),
      ),
    )
  })

  it('keeps each member power a list had as a workspace power, for every case', async () => {
    const after = await inRolledBackTransaction(async (tx) => {
      await insertApiKeys(tx)
      await tx.execute(sql.raw(MIGRATION))

      return readScopes(tx, 'api_keys')
    })

    for (const entry of CASES) {
      const stored = after[`apik_${entry.name}`] ?? []
      const known = stored.filter(isApiKeyScope)

      expect(known, `${entry.name} stored a scope this version does not know`).toHaveLength(stored.length)
      expect(satisfiesApiKeyScope(known, 'members:read'), `${entry.name} reads members`).toBe(
        satisfiesApiKeyScope(entry.before, 'workspace:read'),
      )
      expect(satisfiesApiKeyScope(known, 'members:write'), `${entry.name} changes members`).toBe(
        satisfiesApiKeyScope(entry.before, 'workspace:write'),
      )
    }
  })

  it('changes nothing on a second run', async () => {
    const runs = await inRolledBackTransaction(async (tx) => {
      await insertApiKeys(tx)
      await insertOAuthRows(tx)
      await tx.execute(sql.raw(MIGRATION))
      const once = {
        keys: await readScopes(tx, 'api_keys'),
        grants: await readScopes(tx, 'oauth_grants'),
        tokens: await readScopes(tx, 'oauth_tokens'),
      }

      await tx.execute(sql.raw(MIGRATION))

      return {
        once,
        twice: {
          keys: await readScopes(tx, 'api_keys'),
          grants: await readScopes(tx, 'oauth_grants'),
          tokens: await readScopes(tx, 'oauth_tokens'),
        },
      }
    })

    expect(runs.twice).toEqual(runs.once)
  })
})
