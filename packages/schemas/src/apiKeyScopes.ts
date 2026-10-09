/**
 * API key scopes: preset bundles and fine-grained per-resource permissions.
 *
 * Presets expand to granular scopes at enforcement time. An empty scope list on
 * a key means full access.
 *
 * Three verbs. `read` and `write` exist for every resource, and write implies
 * read. `delete` exists for the object-data resources only, and it is apart:
 * write does not imply it, and it implies neither write nor read. A record
 * that is gone cannot be put back, so the power to remove one is given by
 * name. Workspace admin and object config resources have no delete scope;
 * their deletes need the write scope, which only an admin preset gives.
 */

/** Preset bundles — stored on the key and shown as one badge in the UI. */
export const API_KEY_PRESET_SCOPES = [
  'read:all',
  'write:all',
  'read:objects',
  'write:objects',
  'delete:objects',
  'read:admin',
  'write:admin',
  'admin:objects',
  'admin',
] as const

export type ApiKeyPresetScope = (typeof API_KEY_PRESET_SCOPES)[number]

/**
 * What a new API key gets when the request names no scopes: enough to read
 * and write CRM records. Nothing administrative, no delete, no write to the
 * handbook. Full access is asked for by name, with `full_access`.
 */
export const API_KEY_DEFAULT_SCOPES: readonly ApiKeyPresetScope[] = ['read:objects', 'write:objects']

/** Resources that hold CRM and content data (not workspace admin). */
export const API_KEY_OBJECT_DATA_RESOURCES = [
  'people',
  'companies',
  'positions',
  'deals',
  'enquiries',
  'opportunities',
  'partnerships',
  'raises',
  'roles',
  'candidates',
  'events',
  'attendances',
  'decisions',
  'plan_items',
  'notes',
  'lists',
  'handbook',
  'forms',
] as const

/** Read-only object-data surfaces. */
export const API_KEY_OBJECT_READ_ONLY_RESOURCES = ['activities', 'search', 'dashboard', 'tags'] as const

/** Object configuration (schema-ish admin). */
export const API_KEY_OBJECT_CONFIG_RESOURCES = [
  'custom_fields',
  'pipeline_stages',
  'consent_purposes',
] as const

/** Workspace administration surfaces. */
export const API_KEY_ADMIN_RESOURCES = [
  'workspace',
  'import_export',
  'webhooks',
  'api_keys',
  'agent_tasks',
  'agents',
  'agent_runs',
  'modules',
  'sample_data',
  'ai',
] as const

type ObjectDataResource = (typeof API_KEY_OBJECT_DATA_RESOURCES)[number]

type WritableResource =
  | ObjectDataResource
  | (typeof API_KEY_OBJECT_CONFIG_RESOURCES)[number]
  | (typeof API_KEY_ADMIN_RESOURCES)[number]

type ReadableResource =
  | WritableResource
  | (typeof API_KEY_OBJECT_READ_ONLY_RESOURCES)[number]

function readScope(resource: ReadableResource): `${ReadableResource}:read` {
  return `${resource}:read`
}

function writeScope(resource: WritableResource): `${WritableResource}:write` {
  return `${resource}:write`
}

function deleteScope(resource: ObjectDataResource): `${ObjectDataResource}:delete` {
  return `${resource}:delete`
}

const OBJECT_DATA_READ_SCOPES = [
  ...API_KEY_OBJECT_DATA_RESOURCES.map(readScope),
  ...API_KEY_OBJECT_READ_ONLY_RESOURCES.map(readScope),
] as const

const OBJECT_DATA_WRITE_SCOPES = API_KEY_OBJECT_DATA_RESOURCES.map(writeScope)
const OBJECT_DATA_DELETE_SCOPES = API_KEY_OBJECT_DATA_RESOURCES.map(deleteScope)

const OBJECT_CONFIG_READ_SCOPES = API_KEY_OBJECT_CONFIG_RESOURCES.map(readScope)
const OBJECT_CONFIG_WRITE_SCOPES = API_KEY_OBJECT_CONFIG_RESOURCES.map(writeScope)

const ADMIN_READ_SCOPES = API_KEY_ADMIN_RESOURCES.map(readScope)
const ADMIN_WRITE_SCOPES = API_KEY_ADMIN_RESOURCES.map(writeScope)

/**
 * Scopes that are not a read or a write of a resource. Each one allows an
 * action that a person must give on purpose, so no preset includes any of
 * them. A key with an empty scope list has them, as it has everything.
 *
 * `decisions:commit`: a Decision this credential writes is a commitment at
 * once. Without it the Decision is a proposal until a member confirms it.
 */
export const API_KEY_EXTRA_SCOPES = ['decisions:commit'] as const

export type ApiKeyExtraScope = (typeof API_KEY_EXTRA_SCOPES)[number]

/** Fine-grained per-resource scopes. */
export const API_KEY_GRANULAR_SCOPES = [
  ...OBJECT_DATA_READ_SCOPES,
  ...OBJECT_DATA_WRITE_SCOPES,
  ...OBJECT_DATA_DELETE_SCOPES,
  ...OBJECT_CONFIG_READ_SCOPES,
  ...OBJECT_CONFIG_WRITE_SCOPES,
  ...ADMIN_READ_SCOPES,
  ...ADMIN_WRITE_SCOPES,
  ...API_KEY_EXTRA_SCOPES,
] as const

export type ApiKeyGranularScope = (typeof API_KEY_GRANULAR_SCOPES)[number]

export const API_KEY_SCOPES = [...API_KEY_PRESET_SCOPES, ...API_KEY_GRANULAR_SCOPES] as const

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export const API_KEY_SCOPE_LABELS: Readonly<Record<ApiKeyScope, string>> = {
  'read:all': 'Read all',
  'write:all': 'Write all',
  'read:objects': 'Read objects',
  'write:objects': 'Write objects',
  'delete:objects': 'Delete objects',
  'read:admin': 'Read admin',
  'write:admin': 'Write admin',
  'admin:objects': 'Object admin',
  admin: 'Admin',
  'people:read': 'People (read)',
  'people:write': 'People (write)',
  'companies:read': 'Companies (read)',
  'companies:write': 'Companies (write)',
  'positions:read': 'Positions (read)',
  'positions:write': 'Positions (write)',
  'deals:read': 'Deals (read)',
  'deals:write': 'Deals (write)',
  'enquiries:read': 'Enquiries (read)',
  'enquiries:write': 'Enquiries (write)',
  'opportunities:read': 'Opportunities (read)',
  'opportunities:write': 'Opportunities (write)',
  'partnerships:read': 'Partnerships (read)',
  'partnerships:write': 'Partnerships (write)',
  'raises:read': 'Raises (read)',
  'raises:write': 'Raises (write)',
  'roles:read': 'Roles (read)',
  'roles:write': 'Roles (write)',
  'candidates:read': 'Candidates (read)',
  'candidates:write': 'Candidates (write)',
  'events:read': 'Events (read)',
  'events:write': 'Events (write)',
  'attendances:read': 'Attendances (read)',
  'attendances:write': 'Attendances (write)',
  'decisions:read': 'Decisions (read)',
  'decisions:write': 'Decisions (write)',
  'plan_items:read': 'Plan items (read)',
  'plan_items:write': 'Plan items (write)',
  'notes:read': 'Notes (read)',
  'notes:write': 'Notes (write)',
  'lists:read': 'Lists (read)',
  'lists:write': 'Lists (write)',
  'handbook:read': 'Handbook (read)',
  'handbook:write': 'Handbook (write)',
  'forms:read': 'Forms (read)',
  'forms:write': 'Forms (write)',
  'people:delete': 'People (delete)',
  'companies:delete': 'Companies (delete)',
  'positions:delete': 'Positions (delete)',
  'deals:delete': 'Deals (delete)',
  'enquiries:delete': 'Enquiries (delete)',
  'opportunities:delete': 'Opportunities (delete)',
  'partnerships:delete': 'Partnerships (delete)',
  'raises:delete': 'Raises (delete)',
  'roles:delete': 'Roles (delete)',
  'candidates:delete': 'Candidates (delete)',
  'events:delete': 'Events (delete)',
  'attendances:delete': 'Attendances (delete)',
  'decisions:delete': 'Decisions (delete)',
  'plan_items:delete': 'Plan items (delete)',
  'notes:delete': 'Notes (delete)',
  'lists:delete': 'Lists (delete)',
  'handbook:delete': 'Handbook (delete)',
  'forms:delete': 'Forms (delete)',
  'activities:read': 'Activities (read)',
  'search:read': 'Search (read)',
  'dashboard:read': 'Dashboard (read)',
  'tags:read': 'Tags (read)',
  'custom_fields:read': 'Custom fields (read)',
  'custom_fields:write': 'Custom fields (write)',
  'pipeline_stages:read': 'Pipeline stages (read)',
  'pipeline_stages:write': 'Pipeline stages (write)',
  'consent_purposes:read': 'Consent purposes (read)',
  'consent_purposes:write': 'Consent purposes (write)',
  'workspace:read': 'Workspace (read)',
  'workspace:write': 'Workspace (write)',
  'import_export:read': 'Import / export (read)',
  'import_export:write': 'Import / export (write)',
  'webhooks:read': 'Webhooks (read)',
  'webhooks:write': 'Webhooks (write)',
  'api_keys:read': 'API keys (read)',
  'api_keys:write': 'API keys (write)',
  'agent_tasks:read': 'Agent tasks (read)',
  'agent_tasks:write': 'Agent tasks (write)',
  'agents:read': 'Agents (read)',
  'agents:write': 'Agents (write)',
  'agent_runs:read': 'Agent runs (read)',
  'agent_runs:write': 'Agent runs (write)',
  'modules:read': 'Modules (read)',
  'modules:write': 'Modules (write)',
  'sample_data:read': 'Sample data (read)',
  'sample_data:write': 'Sample data (write)',
  'ai:read': 'AI (read)',
  'ai:write': 'AI (write)',
  'decisions:commit': 'Decisions (commit without confirmation)',
}

const PRESET_EXPANSIONS: Readonly<Record<ApiKeyPresetScope, readonly ApiKeyGranularScope[]>> = {
  'read:all': [...API_KEY_GRANULAR_SCOPES.filter((scope) => scope.endsWith(':read'))],
  'write:all': [...API_KEY_GRANULAR_SCOPES.filter((scope) => scope.endsWith(':write'))],
  'read:objects': [...OBJECT_DATA_READ_SCOPES],
  // Without the handbook. Agents read it as the company's own guidance on
  // voice and selling, so the power to change it is given by name, or by
  // `write:all`.
  'write:objects': [...OBJECT_DATA_WRITE_SCOPES.filter((scope) => scope !== 'handbook:write')],
  'delete:objects': [...OBJECT_DATA_DELETE_SCOPES],
  'read:admin': [...ADMIN_READ_SCOPES],
  'write:admin': [...ADMIN_WRITE_SCOPES],
  'admin:objects': [...OBJECT_CONFIG_WRITE_SCOPES],
  admin: [...ADMIN_WRITE_SCOPES, ...OBJECT_CONFIG_WRITE_SCOPES],
}

/**
 * One sentence on what a scope lets a credential do, for the scopes a person
 * must give on purpose. Shown beside the checkbox in the key form and on the
 * OAuth consent page.
 */
export const API_KEY_SCOPE_RISKS: Readonly<Partial<Record<ApiKeyScope, string>>> = {
  'decisions:commit':
    'Lets it record a Decision as a commitment. Without this, a Decision it writes is a proposal until a member confirms it.',
  'handbook:write':
    'Lets it create and change handbook pages. Agents read the handbook as the company\'s own guidance.',
  'delete:objects': 'Lets it delete records and handbook pages. A deleted record cannot be restored.',
}

/**
 * UI groupings for the custom scope picker. `API_KEY_EXTRA_SCOPES` are not in
 * a group: the picker shows them apart, because a preset never includes one.
 */
export const API_KEY_SCOPE_GROUPS: readonly {
  readonly label: string
  readonly scopes: readonly ApiKeyGranularScope[]
}[] = [
  {
    label: 'Object data',
    scopes: [...OBJECT_DATA_READ_SCOPES, ...OBJECT_DATA_WRITE_SCOPES, ...OBJECT_DATA_DELETE_SCOPES],
  },
  {
    label: 'Object config',
    scopes: [...OBJECT_CONFIG_READ_SCOPES, ...OBJECT_CONFIG_WRITE_SCOPES],
  },
  {
    label: 'Workspace admin',
    scopes: [...ADMIN_READ_SCOPES, ...ADMIN_WRITE_SCOPES],
  },
]

export function isApiKeyPresetScope(scope: ApiKeyScope): scope is ApiKeyPresetScope {
  return (API_KEY_PRESET_SCOPES as readonly string[]).includes(scope)
}

export function isApiKeyGranularScope(scope: ApiKeyScope): scope is ApiKeyGranularScope {
  return (API_KEY_GRANULAR_SCOPES as readonly string[]).includes(scope)
}

/** Flattens preset tokens to the granular set used for enforcement. */
export function expandApiKeyScopes(scopes: readonly ApiKeyScope[]): ReadonlySet<ApiKeyGranularScope> {
  const expanded = new Set<ApiKeyGranularScope>()

  for (const scope of scopes) {
    if (isApiKeyPresetScope(scope)) {
      for (const granular of PRESET_EXPANSIONS[scope]) {
        expanded.add(granular)
      }
    } else if (isApiKeyGranularScope(scope)) {
      expanded.add(scope)
    }
  }

  return expanded
}

/**
 * Whether a stored scope set satisfies a required granular scope. Empty stored = full access.
 *
 * Write implies read for the same resource. Nothing implies delete, and
 * delete implies nothing: a key that can remove a record by id need not be
 * able to read or change one.
 */
export function satisfiesApiKeyScope(
  stored: readonly ApiKeyScope[],
  required: ApiKeyGranularScope,
): boolean {
  if (stored.length === 0) {
    return true
  }

  const expanded = expandApiKeyScopes(stored)

  if (expanded.has(required)) {
    return true
  }

  if (required.endsWith(':read')) {
    const writeScope = required.replace(/:read$/u, ':write') as ApiKeyGranularScope

    if (expanded.has(writeScope)) {
      return true
    }
  }

  return false
}

export function dedupeApiKeyScopes(scopes: readonly ApiKeyScope[]): ApiKeyScope[] {
  return [...new Set(scopes)]
}
