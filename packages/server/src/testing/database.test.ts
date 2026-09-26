import { describe, expect, it } from 'vitest'

import { testDatabaseUrl } from './database.ts'

const configured = 'postgres://kelpie:kelpie@localhost:5432/kelpie_test'

describe('testDatabaseUrl', () => {
  it('is undefined without TEST_DATABASE_URL, scope or not', () => {
    expect(testDatabaseUrl({})).toBeUndefined()
    expect(testDatabaseUrl({}, 'ai')).toBeUndefined()
  })

  it('suffixes the worker pool id', () => {
    expect(testDatabaseUrl({ TEST_DATABASE_URL: configured, VITEST_POOL_ID: '3' })).toBe(`${configured}_3`)
  })

  it('puts a scope before the pool id, so a scoped suite never shares the core database', () => {
    expect(testDatabaseUrl({ TEST_DATABASE_URL: configured, VITEST_POOL_ID: '3' }, 'ai')).toBe(`${configured}_ai_3`)
    expect(testDatabaseUrl({ TEST_DATABASE_URL: configured }, 'ai')).toBe(`${configured}_ai`)
  })

  it('refuses a scope that is not a plain identifier', () => {
    expect(() => testDatabaseUrl({ TEST_DATABASE_URL: configured }, 'a"i')).toThrow(/scope/u)
  })
})
