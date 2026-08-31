import {
  isRepeatableMapTarget,
  labelForMapTarget,
  listMapTargetEntries,
  metaForMapTargetEntry,
} from '@kelpie/schemas'
import type { CustomFieldDefinition } from '@kelpie/schemas'

import { useCustomFields } from '../../api/resources/customFields.ts'
import { EntitySearch } from '../../components/EntitySearch.tsx'
import type { SearchOption } from '../../components/EntitySearch.tsx'

export interface MapTargetSearchProps {
  readonly value: string
  readonly usedTargets: ReadonlySet<string>
  readonly onChange: (target: string) => void
}

function toCustomRefs(
  definitions: readonly CustomFieldDefinition[],
): readonly { objectType: CustomFieldDefinition['objectType']; key: string; label: string; type: CustomFieldDefinition['type'] }[] {
  return definitions.map((definition) => ({
    objectType: definition.objectType,
    key: definition.key,
    label: definition.label,
    type: definition.type,
  }))
}

export function MapTargetSearch({
  value,
  usedTargets,
  onChange,
}: MapTargetSearchProps): React.JSX.Element {
  const customFields = useCustomFields()
  const customRefs = toCustomRefs(customFields.records)
  const entries = listMapTargetEntries(customRefs)

  const options: readonly SearchOption[] = entries
    .filter((entry) => entry.target === value || !usedTargets.has(entry.target) || isRepeatableMapTarget(entry.target))
    .map((entry) => {
      const customType =
        entry.fieldKind === 'custom'
          ? customRefs.find(
              (definition) =>
                entry.target.endsWith(`.custom_fields.${definition.key}`) &&
                entry.target.startsWith(`${definition.objectType}.`),
            )?.type
          : undefined

      return {
        id: entry.target,
        label: labelForMapTarget(entry.target, customRefs),
        meta: metaForMapTargetEntry(entry, customType),
      }
    })

  return (
    <EntitySearch
      options={options}
      value={value}
      onChange={onChange}
      placeholder="Search object and field…"
      emptyMessage="No matching fields"
      limit={12}
      size="md"
    />
  )
}
