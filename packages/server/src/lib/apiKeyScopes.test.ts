import { describe, expect, it } from 'vitest'

import { expandApiKeyScopes, satisfiesApiKeyScope } from '@kelpie/schemas'

import { resolveRestScope } from './apiKeyScopes.ts'

describe('expandApiKeyScopes', () => {
  it('expands read:objects to CRM read scopes', () => {
    const expanded = expandApiKeyScopes(['read:objects'])

    expect(expanded.has('people:read')).toBe(true)
    expect(expanded.has('webhooks:read')).toBe(false)
  })

  it('expands admin to admin write scopes', () => {
    const expanded = expandApiKeyScopes(['admin'])

    expect(expanded.has('webhooks:write')).toBe(true)
    expect(expanded.has('custom_fields:write')).toBe(true)
  })

  it('keeps granular scopes', () => {
    const expanded = expandApiKeyScopes(['people:read', 'deals:write'])

    expect(expanded.has('people:read')).toBe(true)
    expect(expanded.has('deals:write')).toBe(true)
  })
})

describe('satisfiesApiKeyScope', () => {
  it('treats empty stored scopes as full access', () => {
    expect(satisfiesApiKeyScope([], 'webhooks:write')).toBe(true)
  })

  it('lets write satisfy read for the same resource', () => {
    expect(satisfiesApiKeyScope(['people:write'], 'people:read')).toBe(true)
  })

  it('refuses a missing scope', () => {
    expect(satisfiesApiKeyScope(['people:read'], 'people:write')).toBe(false)
  })
})

describe('resolveRestScope', () => {
  it('maps people reads', () => {
    expect(resolveRestScope('GET', '/v1/people')).toBe('people:read')
  })

  it('maps people writes', () => {
    expect(resolveRestScope('POST', '/v1/people')).toBe('people:write')
  })

  it('exempts auth routes', () => {
    expect(resolveRestScope('GET', '/v1/auth/me')).toBeNull()
  })

  it('needs forms write to delete submissions, one or several', () => {
    expect(resolveRestScope('DELETE', '/v1/forms/frm_1/submissions/sub_1')).toBe('forms:write')
    expect(resolveRestScope('POST', '/v1/forms/frm_1/submissions/delete')).toBe('forms:write')
  })

  it('needs forms write to regenerate a slug or release a held submission', () => {
    expect(resolveRestScope('POST', '/v1/forms/frm_1/regenerate-slug')).toBe('forms:write')
    expect(resolveRestScope('POST', '/v1/forms/frm_1/submissions/sub_1/release')).toBe('forms:write')
  })

  it('needs ai read to see AI settings and runs, and ai write to change settings or run intake', () => {
    expect(resolveRestScope('GET', '/v1/ai/settings')).toBe('ai:read')
    expect(resolveRestScope('GET', '/v1/ai/runs')).toBe('ai:read')
    expect(resolveRestScope('GET', '/v1/ai/runs/airun_1')).toBe('ai:read')
    expect(resolveRestScope('POST', '/v1/ai/settings')).toBe('ai:write')
    expect(resolveRestScope('DELETE', '/v1/ai/settings')).toBe('ai:write')
    expect(resolveRestScope('POST', '/v1/ai/person-intake/identify')).toBe('ai:write')
    expect(resolveRestScope('POST', '/v1/ai/person-intake/research')).toBe('ai:write')
    expect(resolveRestScope('POST', '/v1/ai/person-intake/apply')).toBe('ai:write')
  })
})
