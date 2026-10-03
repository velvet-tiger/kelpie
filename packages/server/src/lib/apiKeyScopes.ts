import type { ApiKeyGranularScope, ApiKeyScope } from '@kelpie/schemas'
import { satisfiesApiKeyScope } from '@kelpie/schemas'

import { isBearerActor } from './actor.ts'
import type { Actor } from './actor.ts'
import { AppError } from './errors.ts'

/**
 * REST scope enforcement for API keys. MCP tools declare their own scope.
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

  // Session only: the service refuses every bearer credential with 403.
  if (path.startsWith('/v1/oauth/')) {
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
  { methods: ['GET'], pattern: /^\/v1\/(?:events(?:\/[^/]+(?:\/attendances)?)?|event-associations)$/u, scope: 'events:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/(?:events(?:\/[^/]+(?:\/attendances)?)?|event-associations)$/u, scope: 'events:write' },
  { methods: ['GET'], pattern: /^\/v1\/attendances(?:\/[^/]+)?$/u, scope: 'attendances:read' },
  { methods: ['POST', 'PATCH', 'DELETE'], pattern: /^\/v1\/attendances(?:\/[^/]+)?$/u, scope: 'attendances:write' },
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
  { methods: ['DELETE'], pattern: /^\/v1\/forms\/[^/]+\/submissions\/[^/]+$/u, scope: 'forms:write' },
  { methods: ['POST'], pattern: /^\/v1\/forms\/[^/]+\/submissions\/delete$/u, scope: 'forms:write' },
  { methods: ['POST'], pattern: /^\/v1\/forms\/[^/]+\/regenerate-slug$/u, scope: 'forms:write' },
  { methods: ['POST'], pattern: /^\/v1\/forms\/[^/]+\/submissions\/[^/]+\/release$/u, scope: 'forms:write' },
  { methods: ['GET'], pattern: /^\/v1\/activities$/u, scope: 'activities:read' },
  { methods: ['GET'], pattern: /^\/v1\/search$/u, scope: 'search:read' },
  { methods: ['GET'], pattern: /^\/v1\/dashboard$/u, scope: 'dashboard:read' },
  { methods: ['GET'], pattern: /^\/v1\/tags$/u, scope: 'tags:read' },
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
  { methods: ['POST'], pattern: /^\/v1\/workspaces\/[^/]+\/handbook\/seed$/u, scope: 'handbook:write' },
  { methods: ['POST'], pattern: /^\/v1\/workspaces\/[^/]+\/relink-email-domains$/u, scope: 'workspace:write' },
  { methods: ['GET'], pattern: /^\/v1\/mcp\/tools$/u, scope: 'search:read' },
  { methods: ['GET'], pattern: /^\/v1\/ai\/(?:settings|runs(?:\/[^/]+)?)$/u, scope: 'ai:read' },
  { methods: ['POST', 'DELETE'], pattern: /^\/v1\/ai\/settings$/u, scope: 'ai:write' },
  // Person intake spends the workspace's AI budget. Every record it reads or
  // writes also needs that record's own scope, which the tools check.
  { methods: ['POST'], pattern: /^\/v1\/ai\/person-intake\/(?:identify|research|apply)$/u, scope: 'ai:write' },
]

function storedScopes(actor: Actor): readonly ApiKeyScope[] {
  if (!isBearerActor(actor)) {
    return []
  }

  return actor.scopes
}

/**
 * Sessions are never scoped. For an API key an empty list means full access;
 * for an OAuth grant it means nothing, because a grant is always issued with
 * at least one scope and an empty one can only be a defect.
 */
export function hasApiKeyScope(actor: Actor, required: ApiKeyGranularScope): boolean {
  if (!isBearerActor(actor)) {
    return true
  }

  if (actor.kind === 'oauth' && actor.scopes.length === 0) {
    return false
  }

  return satisfiesApiKeyScope(actor.scopes, required)
}

export function requireApiKeyScope(actor: Actor, required: ApiKeyGranularScope): void {
  if (hasApiKeyScope(actor, required)) {
    return
  }

  const credential = actor.kind === 'oauth' ? 'OAuth token' : 'API key'

  throw new AppError('forbidden', `This ${credential} does not have the ${required} scope`)
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

export function actorHasStoredScopes(actor: Actor): boolean {
  return storedScopes(actor).length > 0
}
