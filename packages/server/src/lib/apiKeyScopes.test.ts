import { describe, expect, it } from 'vitest'

import {
  API_KEY_OBJECT_DATA_RESOURCES,
  API_KEY_OPT_IN_SCOPES,
  API_KEY_PRESET_SCOPES,
  API_KEY_SCOPES,
  API_KEY_SENSITIVE_PRESET_SCOPES,
  apiKeyScopeRisk,
  expandApiKeyScopes,
  isApiKeyRiskScope,
  isSensitiveApiKeyScope,
  satisfiesApiKeyScope,
  sensitiveApiKeyScopesHeld,
} from '@kelpie/schemas'

import type { Actor } from './actor.ts'
import {
  isScopedCredential,
  isScopeExemptRoute,
  resolveRestScope,
  routeScopeRuleFor,
} from './apiKeyScopes.ts'

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

describe('delete scopes', () => {
  it('exist for every object-data resource, and delete:objects is all of them and nothing else', () => {
    const expanded = expandApiKeyScopes(['delete:objects'])

    expect([...expanded].sort()).toEqual(API_KEY_OBJECT_DATA_RESOURCES.map((resource) => `${resource}:delete`).sort())
  })

  it('are in no other preset, alone or all together', () => {
    const others = API_KEY_PRESET_SCOPES.filter((preset) => preset !== 'delete:objects')

    for (const preset of others) {
      expect(satisfiesApiKeyScope([preset], 'people:delete'), preset).toBe(false)
    }

    expect(satisfiesApiKeyScope(others, 'people:delete')).toBe(false)
    expect(satisfiesApiKeyScope(others, 'handbook:delete')).toBe(false)
  })

  it('are not implied by write, and imply neither write nor read', () => {
    expect(satisfiesApiKeyScope(['people:write'], 'people:delete')).toBe(false)
    expect(satisfiesApiKeyScope(['people:delete'], 'people:write')).toBe(false)
    expect(satisfiesApiKeyScope(['people:delete'], 'people:read')).toBe(false)
    expect(satisfiesApiKeyScope(['delete:objects'], 'people:read')).toBe(false)
  })

  it('are held by a key that names one, and by a key with no scopes', () => {
    expect(satisfiesApiKeyScope(['people:delete'], 'people:delete')).toBe(true)
    expect(satisfiesApiKeyScope(['delete:objects'], 'forms:delete')).toBe(true)
    expect(satisfiesApiKeyScope(['people:delete'], 'companies:delete')).toBe(false)
    expect(satisfiesApiKeyScope([], 'people:delete')).toBe(true)
  })
})

describe('handbook:write', () => {
  it('is not in write:objects, which keeps every other object-data write', () => {
    const expanded = expandApiKeyScopes(['write:objects'])

    expect(expanded.has('handbook:write')).toBe(false)
    expect(satisfiesApiKeyScope(['write:objects'], 'handbook:read')).toBe(false)
    expect(satisfiesApiKeyScope(['read:objects', 'write:objects'], 'handbook:read')).toBe(true)

    for (const resource of API_KEY_OBJECT_DATA_RESOURCES.filter((name) => name !== 'handbook')) {
      expect(expanded.has(`${resource}:write`), resource).toBe(true)
    }
  })

  it('is in write:all, and is held by name', () => {
    expect(satisfiesApiKeyScope(['write:all'], 'handbook:write')).toBe(true)
    expect(satisfiesApiKeyScope(['handbook:write'], 'handbook:write')).toBe(true)
    expect(satisfiesApiKeyScope(['admin', 'admin:objects'], 'handbook:write')).toBe(false)
  })
})

describe('sensitive scopes', () => {
  it('are every scope that gives a delete, a handbook write or decisions:commit, under any name', () => {
    for (const scope of ['people:delete', 'handbook:delete', 'handbook:write', 'decisions:commit'] as const) {
      expect(isSensitiveApiKeyScope(scope), scope).toBe(true)
    }

    for (const scope of ['read:all', 'read:objects', 'write:objects', 'write:admin', 'admin', 'people:write'] as const) {
      expect(isSensitiveApiKeyScope(scope), scope).toBe(false)
    }
  })

  it('name the presets that hold one, and that list matches what the presets expand to', () => {
    expect(API_KEY_PRESET_SCOPES.filter(isSensitiveApiKeyScope).toSorted()).toEqual(
      [...API_KEY_SENSITIVE_PRESET_SCOPES].toSorted(),
    )
  })

  it('have a risk sentence each, and every scope the forms always offer is one of them', () => {
    const sensitive = API_KEY_SCOPES.filter(isSensitiveApiKeyScope)

    expect(sensitive.filter((scope) => !isApiKeyRiskScope(scope))).toEqual([])
    expect(sensitive.filter(isApiKeyRiskScope).map(apiKeyScopeRisk).filter((sentence) => sentence.length < 20)).toEqual([])
    expect(API_KEY_OPT_IN_SCOPES.filter((scope) => !isSensitiveApiKeyScope(scope))).toEqual([])
    expect(apiKeyScopeRisk('plan_items:delete')).toBe(
      'Lets it delete records of this kind: Plan items. A deleted record cannot be restored.',
    )
  })

  it('are found in a scope list by the power and not by the name', () => {
    expect(sensitiveApiKeyScopesHeld(['read:objects', 'write:objects'])).toEqual([])
    expect(sensitiveApiKeyScopesHeld(['write:objects', 'people:delete'])).toEqual(['people:delete'])
    expect(sensitiveApiKeyScopesHeld(['read:all', 'write:all'])).toEqual(['handbook:write'])
    expect(sensitiveApiKeyScopesHeld(['delete:objects', 'decisions:commit'])).toEqual([
      'decisions:commit',
      'delete:objects',
    ])
    // Every delete scope by name is the same power as the preset.
    expect(
      sensitiveApiKeyScopesHeld(API_KEY_OBJECT_DATA_RESOURCES.map((resource) => `${resource}:delete` as const)),
    ).toEqual(['delete:objects'])
  })
})

describe('decisions:commit', () => {
  it('is in no preset, alone or all together', () => {
    for (const preset of API_KEY_PRESET_SCOPES) {
      expect(satisfiesApiKeyScope([preset], 'decisions:commit')).toBe(false)
    }

    expect(satisfiesApiKeyScope([...API_KEY_PRESET_SCOPES], 'decisions:commit')).toBe(false)
  })

  it('is not implied by decisions:write, and implies neither read nor write', () => {
    expect(satisfiesApiKeyScope(['decisions:write'], 'decisions:commit')).toBe(false)
    expect(satisfiesApiKeyScope(['decisions:commit'], 'decisions:write')).toBe(false)
    expect(satisfiesApiKeyScope(['decisions:commit'], 'decisions:read')).toBe(false)
  })

  it('is held by a key that names it, and by a key with no scopes', () => {
    expect(satisfiesApiKeyScope(['decisions:commit'], 'decisions:commit')).toBe(true)
    expect(satisfiesApiKeyScope([], 'decisions:commit')).toBe(true)
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

  it('needs decisions write to confirm a decision', () => {
    expect(resolveRestScope('POST', '/v1/decisions/dec_1/confirm')).toBe('decisions:write')
  })

  it('needs forms delete to delete submissions, one or several', () => {
    expect(resolveRestScope('DELETE', '/v1/forms/frm_1/submissions/sub_1')).toBe('forms:delete')
    expect(resolveRestScope('POST', '/v1/forms/frm_1/submissions/delete')).toBe('forms:delete')
  })

  it('needs the delete scope of the resource to delete a record, and the write scope to change one', () => {
    expect(resolveRestScope('DELETE', '/v1/people/per_1')).toBe('people:delete')
    expect(resolveRestScope('PATCH', '/v1/people/per_1')).toBe('people:write')
    expect(resolveRestScope('POST', '/v1/people')).toBe('people:write')
    expect(resolveRestScope('DELETE', '/v1/handbook_pages/hbp_1')).toBe('handbook:delete')
    expect(resolveRestScope('DELETE', '/v1/forms/frm_1')).toBe('forms:delete')
    expect(resolveRestScope('DELETE', '/v1/events/evt_1')).toBe('events:delete')
    expect(resolveRestScope('DELETE', '/v1/lists/lst_1')).toBe('lists:delete')
  })

  it('keeps a convert under write: it leaves the source record in place', () => {
    expect(resolveRestScope('POST', '/v1/enquiries/enq_1/convert')).toBe('enquiries:write')
    expect(resolveRestScope('POST', '/v1/deals/deal_1/convert')).toBe('deals:write')
  })

  it('keeps taking a record off a list under lists write', () => {
    expect(resolveRestScope('DELETE', '/v1/lists/lst_1/members/lmb_1')).toBe('lists:write')
    expect(resolveRestScope('POST', '/v1/lists/lst_1/members')).toBe('lists:write')
  })

  it('keeps the deletes of admin and config resources under write', () => {
    expect(resolveRestScope('DELETE', '/v1/webhooks/whk_1')).toBe('webhooks:write')
    expect(resolveRestScope('DELETE', '/v1/api-keys/apik_1')).toBe('api_keys:write')
    expect(resolveRestScope('DELETE', '/v1/custom_fields/cf_1')).toBe('custom_fields:write')
    expect(resolveRestScope('DELETE', '/v1/pipeline_stages/stg_1')).toBe('pipeline_stages:write')
    expect(resolveRestScope('DELETE', '/v1/consent_purposes/cp_1')).toBe('consent_purposes:write')
    expect(resolveRestScope('DELETE', '/v1/import/jobs/imp_1')).toBe('import_export:write')
    expect(resolveRestScope('DELETE', '/v1/workspaces/ws_1/members/mem_1')).toBe('workspace:write')
    expect(resolveRestScope('DELETE', '/v1/workspaces/ws_1/invites/inv_1')).toBe('workspace:write')
    expect(resolveRestScope('DELETE', '/v1/workspaces/ws_1')).toBe('workspace:write')
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

describe('isScopeExemptRoute', () => {
  it('exempts the session-only and public surfaces', () => {
    expect(isScopeExemptRoute('GET', '/v1/account')).toBe(true)
    expect(isScopeExemptRoute('PATCH', '/v1/account/preferences')).toBe(true)
    expect(isScopeExemptRoute('POST', '/v1/auth/login')).toBe(true)
    expect(isScopeExemptRoute('GET', '/v1/public/config')).toBe(true)
    expect(isScopeExemptRoute('POST', '/v1/workspaces')).toBe(true)
  })

  it('ends the account exemption at the path segment', () => {
    expect(isScopeExemptRoute('GET', '/v1/accounts')).toBe(false)
    expect(isScopeExemptRoute('GET', '/v1/accounting/ledgers')).toBe(false)
  })

  it('exempts no route that has a rule or none', () => {
    expect(isScopeExemptRoute('GET', '/v1/people')).toBe(false)
    expect(isScopeExemptRoute('GET', '/v1/no-such-thing')).toBe(false)
  })
})

describe('routeScopeRuleFor', () => {
  it('reads a route path under /v1, with parameters', () => {
    const rule = routeScopeRuleFor(['GET'], '/invoices/:id', 'workspace:read')

    expect(rule.pattern.test('/v1/invoices/inv_1')).toBe(true)
    expect(rule.pattern.test('/v1/invoices')).toBe(false)
    expect(rule.pattern.test('/v1/invoices/inv_1/lines')).toBe(false)
    expect(rule.pattern.test('/v1/invoices/')).toBe(false)
    expect(rule.pattern.test('/invoices/inv_1')).toBe(false)
  })

  it('reads a last * as the path before it and everything below', () => {
    const rule = routeScopeRuleFor(['GET'], '/billing/*', 'workspace:read')

    expect(rule.pattern.test('/v1/billing')).toBe(true)
    expect(rule.pattern.test('/v1/billing/invoices/inv_1')).toBe(true)
    expect(rule.pattern.test('/v1/billings')).toBe(false)
  })

  it('reads a dot as a dot', () => {
    const rule = routeScopeRuleFor(['GET'], '/feeds/latest.json', 'workspace:read')

    expect(rule.pattern.test('/v1/feeds/latest.json')).toBe(true)
    expect(rule.pattern.test('/v1/feeds/latestxjson')).toBe(false)
  })

  it('refuses a path it cannot read, and one that would cover every route', () => {
    for (const path of ['', '/', 'invoices', '/*', '/invoices/*/lines', '/invoices/:id{[0-9]+}', '/invoices/:id?', '/a b']) {
      expect(() => routeScopeRuleFor(['GET'], path, 'workspace:read'), path).toThrow(/scope rule/u)
    }

    expect(() => routeScopeRuleFor([], '/invoices', 'workspace:read')).toThrow(/names no method/u)
  })
})

describe('resolveRestScope with module rules', () => {
  const moduleRules = [
    routeScopeRuleFor(['GET'], '/invoices/:id', 'workspace:read'),
    routeScopeRuleFor(['GET', 'DELETE'], '/people/:id', 'tags:read'),
    routeScopeRuleFor(['GET'], '/account/export', 'workspace:read'),
  ]

  it('gives a module route the scope its module declared, for the declared methods', () => {
    expect(resolveRestScope('GET', '/v1/invoices/inv_1', moduleRules)).toBe('workspace:read')
    expect(resolveRestScope('POST', '/v1/invoices/inv_1', moduleRules)).toBeNull()
    expect(resolveRestScope('GET', '/v1/invoices/inv_1')).toBeNull()
  })

  it('reads core rules first, so a module cannot change a core route or an exemption', () => {
    expect(resolveRestScope('GET', '/v1/people/per_1', moduleRules)).toBe('people:read')
    expect(resolveRestScope('DELETE', '/v1/people/per_1', moduleRules)).toBe('people:delete')
    expect(resolveRestScope('GET', '/v1/account/export', moduleRules)).toBeNull()
  })
})

describe('isScopedCredential', () => {
  const key = {
    kind: 'api_key',
    apiKeyId: 'apik_1',
    userId: null,
    workspaceId: 'ws_1',
    role: 'admin',
    memberId: null,
  } as const

  it('is true for a key with scopes and for every OAuth grant', () => {
    const grant: Actor = {
      kind: 'oauth',
      grantId: 'ogr_1',
      connectionId: 'ocn_1',
      clientId: 'ocl_1',
      userId: 'usr_1',
      workspaceId: 'ws_1',
      role: 'member',
      memberId: 'mem_1',
      scopes: [],
    }

    expect(isScopedCredential({ ...key, scopes: ['people:read'] })).toBe(true)
    expect(isScopedCredential(grant)).toBe(true)
    expect(isScopedCredential({ ...grant, scopes: ['read:all'] })).toBe(true)
  })

  it('is false for a full-access key and for a session', () => {
    expect(isScopedCredential({ ...key, scopes: [] })).toBe(false)
    expect(
      isScopedCredential({
        kind: 'session',
        userId: 'usr_1',
        sessionId: 'ses_1',
        workspaceId: 'ws_1',
        role: 'owner',
        memberId: 'mem_1',
      }),
    ).toBe(false)
  })
})
