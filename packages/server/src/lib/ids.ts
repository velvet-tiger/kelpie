import { ulid } from 'ulid'

/**
 * Identifiers are `<prefix>_<ulid>`. This table is the single source of the
 * prefixes documented in `api.md`; nothing else may hardcode one.
 */
export const idPrefixes = {
  workspace: 'ws',
  user: 'usr',
  session: 'ses',
  passwordResetToken: 'pwr',
  /** Never returned over the wire either, for the same reason as `passwordResetToken`. */
  emailVerificationToken: 'evt',
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
  list: 'list',
  listMember: 'lmem',
  /**
   * Never returns over the wire either: `person_links` has no routes of its
   * own — the link surfaces as a `person_ids` array on each pipeline record —
   * so the prefix is not in `api.md`'s public prefix table, matching `idem`
   * and `rl`. It still comes from this factory rather than a bare ULID call,
   * so every id in the database is generated the same, injectable way.
   */
  personLink: 'plink',
  handbookPage: 'hb',
  form: 'form',
  formField: 'ff',
  formSubmission: 'sub',
  webhook: 'wh',
  /** One settled delivery. `api.md` gained the prefix with the delivery log. */
  webhookDelivery: 'whd',
  agentRegistration: 'ag',
  agentRun: 'run',
  importJob: 'imp',
  /** Never returns over the wire either: identified by `(workspace_id, module_id)` instead. */
  moduleSetting: 'mset',
  /**
   * `idempotency_keys` has no routes of its own and never returns this id over
   * the wire, so it is not in `api.md`'s public prefix table. It still comes
   * from this factory rather than a bare `ulid()` call, so every id in the
   * database is generated the same, injectable way.
   */
  idempotencyKey: 'idem',
  /**
   * Not returned over the wire either, for the same reason as `idempotencyKey`:
   * a bucket is bookkeeping the rate limiter owns, not a resource with routes.
   */
  rateLimitBucket: 'rl',
  /**
   * One published domain event. Stamped on the envelope so downstream consumers
   * (webhooks, MCP subscribers, an eventual outbox) have a stable idempotency
   * key. Not persisted by core.
   */
  event: 'ev',
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
