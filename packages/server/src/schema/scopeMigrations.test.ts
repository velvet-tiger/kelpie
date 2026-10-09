import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  API_KEY_OBJECT_DATA_RESOURCES,
  API_KEY_SCOPES,
  expandApiKeyScopes,
  isApiKeyGranularScope,
  satisfiesApiKeyScope,
} from '@kelpie/schemas'
import type { ApiKeyGranularScope, ApiKeyScope } from '@kelpie/schemas'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { coreMigrationsDirectory } from '../modules/core.ts'
import { connectTestDatabase, testDatabaseUrl } from '../testing/database.ts'
import type { TestDatabase } from '../testing/database.ts'
import { insertWorkspaceFixture } from '../testing/fixtures.ts'
import type { WorkspaceFixture } from '../testing/fixtures.ts'

/**
 * What migration 0065 does to the scope lists that were stored before it.
 *
 * The migration changes rows and no table, so each test writes rows as they
 * were before, runs the migration file as it is on disk, and reads the result.
 * Each test runs in a transaction that is rolled back.
 */

/** Thrown to end the transaction once the rows have been read. Never a failure. */
class RolledBackOnPurpose extends Error {}

const MIGRATION = readFileSync(join(coreMigrationsDirectory, '0065_delete_and_handbook_scopes.sql'), 'utf8').replaceAll(
  '--> statement-breakpoint',
  '',
)

type Transaction = Parameters<Parameters<TestDatabase['db']['transaction']>[0]>[0]

/** A scope list as it was stored before the migration, and what it must hold after. */
const CASES: readonly { readonly name: string; readonly before: readonly string[]; readonly after: readonly string[] }[] = [
  { name: 'full', before: [], after: [] },
  { name: 'read', before: ['read:objects'], after: ['read:objects'] },
  {
    name: 'default',
    before: ['read:objects', 'write:objects'],
    after: ['read:objects', 'write:objects', 'handbook:write', 'delete:objects'],
  },
  { name: 'all', before: ['read:all', 'write:all'], after: ['read:all', 'write:all', 'delete:objects'] },
  {
    name: 'both',
    before: ['write:objects', 'write:all'],
    after: ['write:objects', 'write:all', 'delete:objects'],
  },
  {
    name: 'granular',
    before: ['people:write', 'companies:read', 'handbook:write', 'forms:write'],
    after: ['people:write', 'companies:read', 'handbook:write', 'forms:write', 'people:delete', 'handbook:delete', 'forms:delete'],
  },
  // Config and admin resources have no delete scope: their deletes stay under write.
  {
    name: 'admin',
    before: ['admin', 'admin:objects', 'webhooks:write', 'custom_fields:write', 'api_keys:write'],
    after: ['admin', 'admin:objects', 'webhooks:write', 'custom_fields:write', 'api_keys:write'],
  },
  {
    name: 'mixed',
    before: ['write:objects', 'people:write', 'webhooks:read'],
    after: ['write:objects', 'people:write', 'webhooks:read', 'handbook:write', 'delete:objects'],
  },
]

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('the delete and handbook scope migration', () => {
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

  /** One client, one connection, and for each case with scopes a grant, a code, an access token and a refresh token. */
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

      // One grant for a user, a client and a workspace, so each case has its own workspace.
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

  async function readScopes(tx: Transaction, table: 'api_keys' | 'oauth_grants' | 'oauth_tokens' | 'oauth_requests'): Promise<Record<string, string[]>> {
    const rows = await tx.execute<{ id: string; scopes: string[] }>(
      sql`select id, scopes from ${sql.identifier(table)} order by id`,
    )

    return Object.fromEntries([...rows].map((row) => [row.id, row.scopes]))
  }

  it('gives each API key the scopes that keep what it can do, and leaves a full-access key empty', async () => {
    const after = await inRolledBackTransaction(async (tx) => {
      await insertApiKeys(tx)
      await tx.execute(sql.raw(MIGRATION))

      return readScopes(tx, 'api_keys')
    })

    expect(after).toEqual(Object.fromEntries(CASES.map((entry) => [`apik_${entry.name}`, entry.after])))
  })

  it('does the same for each OAuth grant, authorization code, access token and refresh token', async () => {
    const after = await inRolledBackTransaction(async (tx) => {
      await insertOAuthRows(tx)
      await tx.execute(sql.raw(MIGRATION))

      return { grants: await readScopes(tx, 'oauth_grants'), tokens: await readScopes(tx, 'oauth_tokens') }
    })
    const withScopes = CASES.filter((entry) => entry.before.length > 0)

    expect(after.grants).toEqual(Object.fromEntries(withScopes.map((entry) => [`ogr_${entry.name}`, entry.after])))
    expect(after.tokens).toEqual(
      Object.fromEntries(
        withScopes.flatMap((entry) =>
          ['access', 'code', 'refresh'].map((kind) => [`otk_${entry.name}_${kind}`, entry.after]),
        ),
      ),
    )
  })

  it('leaves a pending consent request as the client sent it', async () => {
    const after = await inRolledBackTransaction(async (tx) => {
      await tx.execute(sql`
        insert into oauth_clients (id, client_id, kind, client_name, redirect_uris)
        values ('oac_test', 'oac_test', 'registered', 'Test Agent', array['http://127.0.0.1:1/cb'])
      `)
      await tx.execute(sql`
        insert into oauth_requests (id, client_row_id, redirect_uri, code_challenge, scopes, resource, expires_at)
        values (
          'oar_pending', 'oac_test', 'http://127.0.0.1:1/cb', 'challenge',
          array['read:objects', 'write:objects'], 'https://kelpie.test/mcp', now() + interval '10 minutes'
        )
      `)
      await tx.execute(sql.raw(MIGRATION))

      return readScopes(tx, 'oauth_requests')
    })

    expect(after).toEqual({ oar_pending: ['read:objects', 'write:objects'] })
  })

  it('changes nothing on a second run', async () => {
    const runs = await inRolledBackTransaction(async (tx) => {
      await insertApiKeys(tx)
      await insertOAuthRows(tx)
      await tx.execute(sql.raw(MIGRATION))

      const first = {
        keys: await readScopes(tx, 'api_keys'),
        grants: await readScopes(tx, 'oauth_grants'),
        tokens: await readScopes(tx, 'oauth_tokens'),
      }

      await tx.execute(sql.raw(MIGRATION))

      const second = {
        keys: await readScopes(tx, 'api_keys'),
        grants: await readScopes(tx, 'oauth_grants'),
        tokens: await readScopes(tx, 'oauth_tokens'),
      }

      return { first, second }
    })

    expect(runs.second).toEqual(runs.first)
  })

  it('does not touch a row whose scopes need no change', async () => {
    const rewritten = await inRolledBackTransaction(async (tx) => {
      await insertApiKeys(tx)
      await tx.execute(sql`update api_keys set name = name`)
      await tx.execute(sql.raw(MIGRATION))

      // `cmin` names the statement of this transaction that last wrote the
      // row. A row the migration left alone still carries the one from the
      // UPDATE above, as the full-access key does.
      const rows = await tx.execute<{ id: string; rewritten: boolean }>(sql`
        select id, cmin::text <> (select cmin::text from api_keys where id = 'apik_full') as rewritten
        from api_keys where id in ('apik_read', 'apik_admin', 'apik_default') order by id
      `)

      return Object.fromEntries([...rows].map((row) => [row.id, row.rewritten]))
    })

    expect(rewritten).toEqual({ apik_admin: false, apik_default: true, apik_read: false })
  })

  /**
   * The two rules the migration must keep, checked on what it wrote and not
   * on a list written by hand. Every stored list still gives everything it
   * gave under the old meaning, and gives nothing that it did not.
   *
   * The lists are built from the code: each scope that existed before, alone,
   * and every object-data write scope together. A resource that is missing
   * from the array in the SQL, or misspelt there, loses its delete and fails
   * the first rule.
   */
  it('keeps every power of every old scope, and adds none, for lists built from the scope vocabulary', async () => {
    const everyWrite = API_KEY_OBJECT_DATA_RESOURCES.map((resource): ApiKeyScope => `${resource}:write`)
    const lists: readonly (readonly ApiKeyScope[])[] = [
      ...OLD_SCOPES.map((scope) => [scope]),
      everyWrite,
      ['read:objects', 'write:objects'],
      ['read:all', 'write:all'],
      ['write:objects', ...everyWrite],
    ]
    const after = await inRolledBackTransaction(async (tx) => {
      for (const [index, before] of lists.entries()) {
        await tx.execute(sql`
          insert into api_keys (id, workspace_id, name, secret_hash, display_prefix, scopes)
          values (${`apik_gen_${String(index)}`}, ${fixture.workspaceId}, 'generated', ${`hash_gen_${String(index)}`}, 'kp_live_…test', ${textArray(before)})
        `)
      }

      await tx.execute(sql.raw(MIGRATION))

      return readScopes(tx, 'api_keys')
    })

    expect(after[`apik_gen_${String(OLD_SCOPES.length)}`]).toEqual([
      ...everyWrite,
      ...API_KEY_OBJECT_DATA_RESOURCES.map((resource) => `${resource}:delete`),
    ])

    for (const [index, before] of lists.entries()) {
      const stored = (after[`apik_gen_${String(index)}`] ?? []).filter(isKnownScope)
      const heldBefore = oldMeaning(before)
      const label = before.join(' ')

      expect(stored.slice(0, before.length), label).toEqual(before)

      for (const power of heldBefore) {
        expect(satisfiesApiKeyScope(stored, power), `${label} lost ${power}`).toBe(true)
      }

      for (const power of expandApiKeyScopes(stored)) {
        expect(heldBefore.has(power), `${label} gained ${power}`).toBe(true)
      }
    }
  })
})

const KNOWN_SCOPES = new Set<string>(API_KEY_SCOPES)

function isKnownScope(scope: string): scope is ApiKeyScope {
  return KNOWN_SCOPES.has(scope)
}

/** The scopes that existed before this release: no delete scope, and no `decisions:commit`. */
const OLD_SCOPES = API_KEY_SCOPES.filter(
  (scope) => !scope.endsWith(':delete') && scope !== 'delete:objects' && scope !== 'decisions:commit',
)

/**
 * What a scope list that is not empty allowed before the migration, in the
 * per-resource scopes of today. It is computed from the expansion as it is
 * now plus the three things that changed: `write:objects` gave
 * `handbook:write`, a write on an object-data resource gave its delete, and
 * a write gives the read, then as now.
 */
function oldMeaning(scopes: readonly ApiKeyScope[]): ReadonlySet<ApiKeyGranularScope> {
  const held = new Set<ApiKeyGranularScope>(expandApiKeyScopes(scopes))

  if (scopes.includes('write:objects')) {
    held.add('handbook:write')
  }

  for (const scope of [...held]) {
    if (!scope.endsWith(':write')) {
      continue
    }

    for (const implied of [scope.replace(/:write$/u, ':delete'), scope.replace(/:write$/u, ':read')]) {
      if (isKnownScope(implied) && isApiKeyGranularScope(implied)) {
        held.add(implied)
      }
    }
  }

  return held
}
