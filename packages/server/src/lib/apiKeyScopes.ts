import type { ApiKeyGranularScope, ApiKeyScope } from '@kelpie/schemas'
import { satisfiesApiKeyScope } from '@kelpie/schemas'

import type { Actor } from './actor.ts'
import { AppError } from './errors.ts'

/**
 * REST and MCP scope enforcement for API keys.
 *
 * Sessions are never scoped. An empty scope list on a key means full access.
 */

interface RouteScopeRule {
  readonly methods: readonly string[]
  readonly pattern: RegExp
  readonly scope: ApiKeyGranularScope
}

/** Paths that need no scope check (session-only or unauthenticated). */
function isExempt(method: string, path: string): boolean {
  if (path.startsWith('/v1/public/')) {
    return true
  }

  if (path.startsWith('/v1/auth/')) {
    return true
  }

  if (path.startsWith('/v1/account')) {
    return true
  }

  if (method === 'POST' && path === '/v1/workspaces') {
    return true
  }

  return method === 'POST' && path === '/v1/invites/accept'
}

const ROUTE_SCOPE_RULES: readonly RouteScopeRule[] = [
  { methods: ['GET'], pattern: /^\/v1\/people(?:\/[^/]+)?$/u, scope: 'people:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/people(?:\/[^/]+)?$/u, scope: 'people:write' },
  { methods: ['GET'], pattern: /^\/v1\/companies(?:\/[^/]+)?$/u, scope: 'companies:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/companies(?:\/[^/]+)?$/u, scope: 'companies:write' },
  { methods: ['GET'], pattern: /^\/v1\/positions(?:\/[^/]+)?$/u, scope: 'positions:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/positions(?:\/[^/]+)?$/u, scope: 'positions:write' },
  { methods: ['GET'], pattern: /^\/v1\/deals(?:\/[^/]+(?:\/convert)?)?$/u, scope: 'deals:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/deals(?:\/[^/]+(?:\/convert)?)?$/u, scope: 'deals:write' },
  { methods: ['GET'], pattern: /^\/v1\/enquiries(?:\/[^/]+(?:\/convert)?)?$/u, scope: 'enquiries:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/enquiries(?:\/[^/]+(?:\/convert)?)?$/u, scope: 'enquiries:write' },
  { methods: ['GET'], pattern: /^\/v1\/opportunities(?:\/[^/]+(?:\/convert)?)?$/u, scope: 'opportunities:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/opportunities(?:\/[^/]+(?:\/convert)?)?$/u, scope: 'opportunities:write' },
  { methods: ['GET'], pattern: /^\/v1\/partnerships(?:\/[^/]+(?:\/convert)?)?$/u, scope: 'partnerships:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/partnerships(?:\/[^/]+(?:\/convert)?)?$/u, scope: 'partnerships:write' },
  { methods: ['GET'], pattern: /^\/v1\/raises(?:\/[^/]+(?:\/convert)?)?$/u, scope: 'raises:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/raises(?:\/[^/]+(?:\/convert)?)?$/u, scope: 'raises:write' },
  { methods: ['GET'], pattern: /^\/v1\/roles(?:\/[^/]+)?$/u, scope: 'roles:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/roles(?:\/[^/]+)?$/u, scope: 'roles:write' },
  { methods: ['GET'], pattern: /^\/v1\/candidates(?:\/[^/]+)?$/u, scope: 'candidates:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/candidates(?:\/[^/]+)?$/u, scope: 'candidates:write' },
  { methods: ['GET'], pattern: /^\/v1\/decisions(?:\/[^/]+)?$/u, scope: 'decisions:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/decisions(?:\/[^/]+)?$/u, scope: 'decisions:write' },
  { methods: ['GET'], pattern: /^\/v1\/plan_items(?:\/[^/]+)?$/u, scope: 'plan_items:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/plan_items(?:\/[^/]+)?$/u, scope: 'plan_items:write' },
  { methods: ['GET'], pattern: /^\/v1\/notes(?:\/[^/]+)?$/u, scope: 'notes:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/notes(?:\/[^/]+)?$/u, scope: 'notes:write' },
  { methods: ['GET'], pattern: /^\/v1\/(?:lists(?:\/[^/]+(?:\/members(?:\/[^/]+)?)?)?|list-memberships)$/u, scope: 'lists:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/(?:lists(?:\/[^/]+(?:\/members(?:\/[^/]+)?)?)?|list-memberships)$/u, scope: 'lists:write' },
  { methods: ['GET'], pattern: /^\/v1\/handbook_pages(?:\/[^/]+)?$/u, scope: 'handbook:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/handbook_pages(?:\/[^/]+)?$/u, scope: 'handbook:write' },
  { methods: ['GET'], pattern: /^\/v1\/(?:forms(?:\/[^/]+(?:\/(?:submissions(?:\/[^/]+)?|embed))?)?|form-submissions)$/u, scope: 'forms:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/forms(?:\/[^/]+)?$/u, scope: 'forms:write' },
  { methods: ['GET'], pattern: /^\/v1\/activities$/u, scope: 'activities:read' },
  { methods: ['GET'], pattern: /^\/v1\/search$/u, scope: 'search:read' },
  { methods: ['GET'], pattern: /^\/v1\/dashboard$/u, scope: 'dashboard:read' },
  { methods: ['GET'], pattern: /^\/v1\/custom_fields(?:\/[^/]+)?$/u, scope: 'custom_fields:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/custom_fields(?:\/[^/]+)?$/u, scope: 'custom_fields:write' },
  { methods: ['GET'], pattern: /^\/v1\/pipeline_stages(?:\/[^/]+)?$/u, scope: 'pipeline_stages:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/pipeline_stages(?:\/[^/]+)?$/u, scope: 'pipeline_stages:write' },
  { methods: ['GET'], pattern: /^\/v1\/consent_purposes(?:\/[^/]+)?$/u, scope: 'consent_purposes:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/consent_purposes(?:\/[^/]+)?$/u, scope: 'consent_purposes:write' },
  { methods: ['GET'], pattern: /^\/v1\/export(?:\/|$)/u, scope: 'import_export:read' },
  { methods: ['GET'], pattern: /^\/v1\/import\/jobs(?:\/[^/]+)?$/u, scope: 'import_export:read' },
  { methods: ['POST', 'DELETE'], pattern: /^\/v1\/import\/jobs(?:\/[^/]+(?:\/commit)?)?$/u, scope: 'import_export:write' },
  { methods: ['GET'], pattern: /^\/v1\/webhooks(?:\/[^/]+(?:\/deliveries)?)?$/u, scope: 'webhooks:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/webhooks(?:\/[^/]+(?:\/rotate_secret)?)?$/u, scope: 'webhooks:write' },
  { methods: ['GET'], pattern: /^\/v1\/api-keys(?:\/[^/]+)?$/u, scope: 'api_keys:read' },
  { methods: ['POST', 'DELETE'], pattern: /^\/v1\/api-keys(?:\/[^/]+)?$/u, scope: 'api_keys:write' },
  { methods: ['GET'], pattern: /^\/v1\/agent-tasks(?:\/[^/]+(?:\/(?:resolve|run))?)?$/u, scope: 'agent_tasks:read' },
  { methods: ['POST'], pattern: /^\/v1\/agent-tasks\/[^/]+(?:\/(?:resolve|run))?$/u, scope: 'agent_tasks:write' },
  { methods: ['GET'], pattern: /^\/v1\/agent-runs(?:\/[^/]+)?$/u, scope: 'agent_runs:read' },
  { methods: ['GET'], pattern: /^\/v1\/agents(?:\/[^/]+)?$/u, scope: 'agents:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/agents(?:\/[^/]+)?$/u, scope: 'agents:write' },
  { methods: ['GET'], pattern: /^\/v1\/workspaces\/[^/]+$/u, scope: 'workspace:read' },
  { methods: ['PATCH'], pattern: /^\/v1\/workspaces\/[^/]+$/u, scope: 'workspace:write' },
  { methods: ['GET'], pattern: /^\/v1\/workspaces\/[^/]+\/members(?:\/[^/]+)?$/u, scope: 'workspace:read' },
  { methods: ['PATCH', 'DELETE'], pattern: /^\/v1\/workspaces\/[^/]+\/members(?:\/[^/]+)?$/u, scope: 'workspace:write' },
  { methods: ['GET'], pattern: /^\/v1\/workspaces\/[^/]+\/invites(?:\/[^/]+(?:\/resend)?)?$/u, scope: 'workspace:read' },
  { methods: ['POST', 'DELETE'], pattern: /^\/v1\/workspaces\/[^/]+\/invites(?:\/[^/]+(?:\/resend)?)?$/u, scope: 'workspace:write' },
  { methods: ['GET'], pattern: /^\/v1\/workspaces\/[^/]+\/modules(?:\/[^/]+)?$/u, scope: 'modules:read' },
  { methods: ['PATCH'], pattern: /^\/v1\/workspaces\/[^/]+\/modules(?:\/[^/]+)?$/u, scope: 'modules:write' },
  { methods: ['POST'], pattern: /^\/v1\/workspaces\/[^/]+\/sample-data$/u, scope: 'sample_data:write' },
  { methods: ['POST'], pattern: /^\/v1\/workspaces\/[^/]+\/relink-email-domains$/u, scope: 'workspace:write' },
  { methods: ['GET'], pattern: /^\/v1\/mcp\/tools$/u, scope: 'search:read' },
]

function storedScopes(actor: Actor): readonly ApiKeyScope[] {
  if (actor.kind !== 'api_key') {
    return []
  }

  return actor.scopes
}

export function hasApiKeyScope(actor: Actor, required: ApiKeyGranularScope): boolean {
  if (actor.kind !== 'api_key') {
    return true
  }

  return satisfiesApiKeyScope(actor.scopes, required)
}

export function requireApiKeyScope(actor: Actor, required: ApiKeyGranularScope): void {
  if (hasApiKeyScope(actor, required)) {
    return
  }

  throw new AppError('forbidden', `This API key does not have the ${required} scope`)
}

export function resolveRestScope(method: string, path: string): ApiKeyGranularScope | null {
  if (isExempt(method, path)) {
    return null
  }

  if (method === 'DELETE' && /^\/v1\/workspaces\/[^/]+$/u.test(path)) {
    return 'workspace:write'
  }

  for (const rule of ROUTE_SCOPE_RULES) {
    if (rule.methods.includes(method) && rule.pattern.test(path)) {
      return rule.scope
    }
  }

  return null
}

const MCP_READ_VERBS = new Set(['list', 'get', 'query'])
const MCP_WRITE_VERBS = new Set(['create', 'update', 'delete', 'commit', 'resolve', 'run', 'rotate_secret', 'install'])

/** Maps REST resource segments used in MCP tool names to scope resources. */
const MCP_RESOURCE_ALIASES: Readonly<Record<string, string>> = {
  handbook_pages: 'handbook',
  plan_items: 'plan_items',
  pipeline_stages: 'pipeline_stages',
  custom_fields: 'custom_fields',
  consent_purposes: 'consent_purposes',
  form_submissions: 'forms',
  list_memberships: 'lists',
  agent_tasks: 'agent_tasks',
  agent_runs: 'agent_runs',
  import_jobs: 'import_export',
  export: 'import_export',
}

export function resolveMcpScope(toolName: string): ApiKeyGranularScope | null {
  if (toolName === 'search_query') {
    return 'search:read'
  }

  const match = /^([a-z0-9_]+)_(list|get|create|update|delete|query|commit|resolve|run|rotate_secret|install)$/u.exec(
    toolName,
  )

  if (match === null) {
    const parts = toolName.split('_')
    const verb = parts.at(-1)

    if (verb === undefined) {
      return null
    }

    const resource = MCP_RESOURCE_ALIASES[parts.slice(0, -1).join('_')] ?? parts.slice(0, -1).join('_')

    if (MCP_READ_VERBS.has(verb)) {
      return `${resource}:read` as ApiKeyGranularScope
    }

    if (MCP_WRITE_VERBS.has(verb)) {
      return `${resource}:write` as ApiKeyGranularScope
    }

    return null
  }

  const [, rawResource, verb] = match
  const resource = MCP_RESOURCE_ALIASES[rawResource ?? ''] ?? rawResource ?? ''

  if (MCP_READ_VERBS.has(verb ?? '')) {
    return `${resource}:read` as ApiKeyGranularScope
  }

  if (MCP_WRITE_VERBS.has(verb ?? '')) {
    return `${resource}:write` as ApiKeyGranularScope
  }

  return null
}

export function actorHasStoredScopes(actor: Actor): boolean {
  return storedScopes(actor).length > 0
}
