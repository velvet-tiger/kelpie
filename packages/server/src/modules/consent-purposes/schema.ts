import { CONSENT_PURPOSE_STATUSES } from '@kelpie/schemas'
import { index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * Workspace-defined consent purposes.
 *
 * Every capture site — a form's consent field, an import job, the manual
 * override on a Person — names one of these. `slug` is set at create and
 * immutable after: a rename would strand every form/import that names it and
 * names it and every `person_consents` row that carries it (identified by
 * the purpose id). The strict PATCH body naturally refuses either as a `422`.
 *
 * `default_status` is the workspace default: a person without an explicit
 * `person_consents` row for this purpose inherits it.
 */
export { CONSENT_PURPOSE_STATUSES } from '@kelpie/schemas'
export type { ConsentPurposeStatus } from '@kelpie/schemas'

export const consentPurposes = pgTable(
  'consent_purposes',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    description: text('description').notNull().default(''),
    defaultStatus: text('default_status').notNull().default('unknown'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('consent_purposes_workspace_idx').on(table.workspaceId),
    unique('consent_purposes_workspace_slug_key').on(table.workspaceId, table.slug),
    checkOneOf(
      'consent_purposes_default_status_check',
      table.defaultStatus,
      CONSENT_PURPOSE_STATUSES,
    ),
  ],
)
