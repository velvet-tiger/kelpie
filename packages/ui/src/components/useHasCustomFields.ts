import type { CustomFieldObjectType } from '@kelpie/schemas'

import { useCustomFields } from '../api/resources/customFields.ts'

/**
 * Whether this workspace has any custom fields for the given object type.
 *
 * A detail page reads this to decide whether to render its Fields tab at all —
 * a workspace with no definitions should not see a Fields tab full of empty
 * space with only a "go set one up" pointer.
 *
 * Lives in its own file so `CustomFieldsPanel.tsx` can stay Fast-Refresh clean
 * (`react/only-export-components`).
 */
export function useHasCustomFields(objectType: CustomFieldObjectType): boolean {
  const definitions = useCustomFields({ objectType, sort: 'sort_order', limit: 200 })
  return definitions.records.length > 0
}
