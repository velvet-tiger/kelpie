import type { ApiKeyScope } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { scopesCover } from './service.ts'

/**
 * `scopesCover` decides which sensitive scopes the consent page shows as
 * already allowed. A wrong yes starts a tick box ticked that nobody ticked.
 */
describe('scopesCover', () => {
  it('is true when the held scopes give the scope by name or through a preset', () => {
    expect(scopesCover(['people:delete'], 'people:delete')).toBe(true)
    expect(scopesCover(['delete:objects'], 'people:delete')).toBe(true)
    expect(scopesCover(['write:all'], 'handbook:write')).toBe(true)
  })

  it('is true for a preset only when every scope in it is held', () => {
    expect(scopesCover(['people:delete', 'deals:delete'], 'delete:objects')).toBe(false)
    expect(scopesCover(['delete:objects'], 'delete:objects')).toBe(true)
  })

  it('is false when nothing is held: an OAuth grant with no scopes has no access', () => {
    expect(scopesCover([], 'people:delete')).toBe(false)
  })

  it('is false for a scope that expands to nothing, whatever is held', () => {
    // A stored row can hold a name that this version does not know. The
    // repository reads scope columns as `ApiKeyScope[]` in the same way.
    const unknown = 'retired:scope' as ApiKeyScope

    expect(scopesCover(['read:all', 'write:all', 'delete:objects'], unknown)).toBe(false)
    expect(scopesCover([unknown], unknown)).toBe(false)
  })
})
