import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/** Domain events published by the positions module. */

export const positionsEvents = {
  'positions.position.created': z.object({}).strict(),
  'positions.position.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'positions.position.deleted': z.object({}).strict(),
} satisfies ModuleEventCatalog

export type PositionCreatedData = Record<string, never>
export interface PositionUpdatedData {
  readonly changed: readonly string[]
}
export type PositionDeletedData = Record<string, never>

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'positions.position.created': PositionCreatedData
    'positions.position.updated': PositionUpdatedData
    'positions.position.deleted': PositionDeletedData
  }
}
