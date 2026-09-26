import { ulid } from 'ulid'

/**
 * Ids for this module's rows.
 *
 * Core documents its own `<prefix>_<ulid>` shape and says nothing about a
 * cloud table's; the module owns its own prefix, the way `modules/integrations`
 * does. The generator is injected so a test can pin an id, and production
 * passes nothing.
 */

export const AI_RUN_ID_PREFIX = 'ai'

export type IdFactory = () => string

export function createAiRunIdFactory(generateUlid: () => string = ulid): IdFactory {
  return () => `${AI_RUN_ID_PREFIX}_${generateUlid()}`
}
