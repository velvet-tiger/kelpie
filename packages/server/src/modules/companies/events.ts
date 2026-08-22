import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/** Domain events published by the companies module. */

export const companiesEvents = {
  'companies.company.created': z.object({}).strict(),
  'companies.company.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'companies.company.deleted': z.object({}).strict(),
} satisfies ModuleEventCatalog

export type CompanyCreatedData = Record<string, never>
export interface CompanyUpdatedData {
  readonly changed: readonly string[]
}
export type CompanyDeletedData = Record<string, never>

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'companies.company.created': CompanyCreatedData
    'companies.company.updated': CompanyUpdatedData
    'companies.company.deleted': CompanyDeletedData
  }
}
