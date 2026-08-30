import { CUSTOM_FIELD_OBJECT_TYPES, CUSTOM_FIELD_TYPES } from '@kelpie/schemas'
import { index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * Workspace-defined field definitions for the six taggable record types.
 *
 * `key` and `type` are set at create and are immutable after: a rename would
 * strand every record's value under an old key, and a type swap would leave the
 * jsonb value in the wrong shape. The strict PATCH body naturally refuses
 * either as a `422`.
 *
 * `options` is stored as jsonb rather than `text[]` so future option metadata
 * (colours, an archived flag) can be added without a migration. Empty for every
 * type but `select` and `multi_select`; the service enforces that half of the
 * rule.
 *
 * Re-exports the two arrays so the routes layer reads them from here alongside
 * the tables they constrain.
 */
export { CUSTOM_FIELD_OBJECT_TYPES, CUSTOM_FIELD_TYPES } from '@kelpie/schemas'
export type { CustomFieldObjectType, CustomFieldType } from '@kelpie/schemas'

export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectType: text('object_type').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').notNull(),
    options: jsonb('options').$type<readonly string[]>().notNull().default([]),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('custom_field_definitions_workspace_idx').on(table.workspaceId),
    index('custom_field_definitions_workspace_object_idx').on(
      table.workspaceId,
      table.objectType,
    ),
    unique('custom_field_definitions_workspace_object_key_key').on(
      table.workspaceId,
      table.objectType,
      table.key,
    ),
    checkOneOf(
      'custom_field_definitions_object_type_check',
      table.objectType,
      CUSTOM_FIELD_OBJECT_TYPES,
    ),
    checkOneOf('custom_field_definitions_type_check', table.type, CUSTOM_FIELD_TYPES),
  ],
)
