import { index, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { createdAt, primaryId, searchVector, updatedAt } from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
import { companies } from '../companies/schema.ts'
import { people } from '../people/schema.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * A person holds a title at a company. Always use this link; there is no bare
 * person-to-company foreign key anywhere.
 *
 * A pure dependent: it dies with either side and nothing restricts on it.
 */
export const positions = pgTable(
  'positions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // A position is never a search result itself. This vector exists so a search
    // for a job title finds the person holding it, which is what the mockup's
    // `/search` and `?q=` on people both do.
    searchVector: searchVector((): readonly SearchVectorPart[] => [{ column: positions.title, weight: 'A' }]),
  },
  (table) => [
    unique('positions_person_company_title_key').on(table.personId, table.companyId, table.title),
    index('positions_workspace_idx').on(table.workspaceId),
    index('positions_company_idx').on(table.companyId),
    index('positions_search_idx').using('gin', table.searchVector),
  ],
)
