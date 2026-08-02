import { ulid } from 'ulid'

/**
 * Identifiers are `<prefix>_<ulid>`. This table is the single source of the
 * prefixes documented in `api.md`; nothing else may hardcode one.
 */
export const idPrefixes = {
  workspace: 'ws',
  user: 'usr',
  session: 'ses',
  teamMember: 'mem',
  invite: 'inv',
  apiKey: 'key',
  person: 'per',
  company: 'com',
  position: 'pos',
  pipelineStage: 'stage',
  deal: 'deal',
  opportunity: 'opp',
  partnership: 'prt',
  raise: 'rse',
  role: 'role',
  candidate: 'cand',
  planItem: 'plan',
  decision: 'dec',
  note: 'note',
  activity: 'act',
  handbookPage: 'hb',
  form: 'form',
  formField: 'ff',
  formSubmission: 'sub',
  webhook: 'wh',
  agentRegistration: 'ag',
  agentRun: 'run',
  importJob: 'imp',
  integrationConnection: 'int',
} as const

export type ObjectKind = keyof typeof idPrefixes

export type IdFactory = (kind: ObjectKind) => string

/**
 * Builds the id factory. The ULID generator is injected so tests can pin ids;
 * production passes nothing and gets time-ordered ULIDs.
 */
export function createIdFactory(generateUlid: () => string = ulid): IdFactory {
  return (kind: ObjectKind): string => `${idPrefixes[kind]}_${generateUlid()}`
}
