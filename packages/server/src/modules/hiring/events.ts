import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/** Domain events published by the hiring module (roles + candidates). */

export const hiringEvents = {
  'hiring.role.created': z.object({}).strict(),
  'hiring.role.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'hiring.role.deleted': z.object({}).strict(),
  'hiring.candidate.created': z.object({}).strict(),
  'hiring.candidate.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'hiring.candidate.deleted': z.object({}).strict(),
} satisfies ModuleEventCatalog

export type RoleCreatedData = Record<string, never>
export interface RoleUpdatedData {
  readonly changed: readonly string[]
}
export type RoleDeletedData = Record<string, never>
export type CandidateCreatedData = Record<string, never>
export interface CandidateUpdatedData {
  readonly changed: readonly string[]
}
export type CandidateDeletedData = Record<string, never>

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'hiring.role.created': RoleCreatedData
    'hiring.role.updated': RoleUpdatedData
    'hiring.role.deleted': RoleDeletedData
    'hiring.candidate.created': CandidateCreatedData
    'hiring.candidate.updated': CandidateUpdatedData
    'hiring.candidate.deleted': CandidateDeletedData
  }
}
