import { parseFormMapTarget } from '@kelpie/schemas'
import type { CustomFieldObjectType, CustomFieldType } from '@kelpie/schemas'

import { normaliseDomain, normaliseEmail } from '../../lib/normalisation.ts'
import type { CustomFieldDefinitionRecord } from '../custom-fields/repository.ts'
import { parseCustomFieldAnswer, parseStandardAnswer, valuesForObject } from './applyMappedFields.ts'
import { COMPANY_FIELD_COLUMNS, PERSON_FIELD_COLUMNS } from './applySubmissionFields.ts'
import { companyAddressFieldsNotHeld, personAddressFieldsNotHeld } from './fillAddresses.ts'
import { mappedTargetsOf } from './mappedValueChecks.ts'
import type { MappedAnswers } from './mapping.ts'

/**
 * Which mapped answers a record that was already in the workspace does not
 * already hold.
 *
 * A submit writes nothing on such a record, and the action log says which
 * answers went nowhere. An answer equal to what the record holds went nowhere
 * in name only: a returning visitor who types their own name again has given
 * staff nothing to copy. So only an answer that differs from the stored value
 * is reported. A stored blank and a typed value differ, and that is the case
 * the entry is for.
 *
 * "Equal" uses the value the write path would store for the target, so no
 * rule here is new: the answer trimmed, a domain or an address through its
 * normaliser, a list answer split the way a write splits it.
 */

/** The record types a submit can match or attach to without creating them. */
export type ExistingRecordType = 'person' | 'company' | 'position' | 'raise'

/** A stored record, read by column name. */
type StoredRecord = Readonly<Record<string, unknown>>

/**
 * The column behind each standard field, for the comparison. The person and
 * company maps add the fields the core capture writes itself to the ones a
 * mapped write uses.
 */
const COLUMNS: Readonly<Record<ExistingRecordType, Readonly<Record<string, string>>>> = {
  person: {
    ...PERSON_FIELD_COLUMNS,
    name: 'name',
    first_name: 'firstName',
    last_name: 'lastName',
    email: 'email',
    phones: 'phones',
  },
  company: { ...COMPANY_FIELD_COLUMNS, name: 'name', domain: 'domain' },
  position: { title: 'title' },
  raise: {
    name: 'name',
    check_size_cents: 'checkSizeCents',
    currency: 'currency',
    thesis_fit: 'thesisFit',
    pass_reason: 'passReason',
    expected_close: 'expectedClose',
    summary: 'summary',
    tags: 'tags',
  },
}

/**
 * The targets compared without regard to case, because the submit's own match
 * on them ignores it: a company is matched by name whatever its case, a held
 * position by title whatever its case, and an address and a domain are stored
 * in lower case. Every other text is compared exactly: "jane smith" is not
 * what a record that says "Jane Smith" holds.
 */
const CASE_INSENSITIVE_TARGETS: ReadonlySet<string> = new Set([
  'person.email',
  'company.name',
  'company.domain',
  'position.title',
])

/** The value a write would store for a standard target. Undefined when the answer cannot be read. */
function storedForm(objectType: ExistingRecordType, field: string, raw: string): unknown {
  const target = `${objectType}.${field}`

  if (target === 'person.email') {
    return normaliseEmail(raw) ?? raw
  }

  if (target === 'company.domain') {
    return normaliseDomain(raw) ?? raw
  }

  // The core capture stores the phone answer whole, as one entry.
  if (target === 'person.phones') {
    return [raw]
  }

  return parseStandardAnswer(objectType, field, raw)
}

/**
 * True when the stored value already says what the answer says.
 *
 * A list answer (phones, tags, a multi-select) is held when every entry of it
 * is already on the stored list. Text, a number and a yes/no are held when
 * the stored value is the same value.
 */
function holds(stored: unknown, answer: unknown, ignoreCase: boolean): boolean {
  if (answer === undefined) {
    return false
  }

  if (Array.isArray(answer)) {
    return Array.isArray(stored) && answer.every((entry) => stored.includes(entry))
  }

  if (typeof answer === 'string' && typeof stored === 'string') {
    return ignoreCase ? stored.toLowerCase() === answer.toLowerCase() : stored === answer
  }

  return stored === answer
}

function isStoredRecord(value: unknown): value is StoredRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCustomFields(record: StoredRecord): StoredRecord {
  return isStoredRecord(record.customFields) ? record.customFields : {}
}

function addressFieldsNotHeld(
  objectType: ExistingRecordType,
  record: StoredRecord,
  standard: Readonly<Record<string, string>>,
): readonly string[] {
  if (objectType === 'person') {
    return personAddressFieldsNotHeld(record.addresses, standard)
  }

  return objectType === 'company' ? companyAddressFieldsNotHeld(record.addresses, standard) : []
}

/**
 * The mapped targets of one record type whose answer the record does not
 * already hold, in the order the answers were mapped.
 *
 * @param record The stored record, as its repository returns it.
 * @param definitions The workspace's custom field definitions, for reading a
 *   custom field's answer as its type.
 */
export function answersNotHeld(
  objectType: ExistingRecordType,
  record: StoredRecord,
  mapped: MappedAnswers,
  definitions: readonly CustomFieldDefinitionRecord[],
): readonly string[] {
  const customFields = readCustomFields(record)
  const addressFields = new Set(
    addressFieldsNotHeld(objectType, record, valuesForObject(mapped, objectType).standard),
  )

  return mappedTargetsOf(mapped, objectType).filter((target) => {
    const parsed = parseFormMapTarget(target)
    const raw = mapped[target]

    if (parsed === undefined || raw === undefined) {
      return true
    }

    if (parsed.isCustomField && parsed.customFieldKey !== undefined) {
      const key = parsed.customFieldKey
      const definition = definitions.find(
        (candidate) => candidate.objectType === objectType && candidate.key === key,
      )

      // No definition means no place the value could be: it is not held.
      return (
        definition === undefined ||
        !holds(
          customFields[key],
          parseCustomFieldAnswer(
            {
              objectType: definition.objectType as CustomFieldObjectType,
              key: definition.key,
              label: definition.label,
              type: definition.type as CustomFieldType,
            },
            raw,
          ),
          false,
        )
      )
    }

    if (parsed.fieldPath.startsWith('address.')) {
      return addressFields.has(parsed.fieldPath)
    }

    const column = COLUMNS[objectType][parsed.fieldPath]

    return (
      column === undefined ||
      !holds(
        record[column],
        storedForm(objectType, parsed.fieldPath, raw),
        CASE_INSENSITIVE_TARGETS.has(target),
      )
    )
  })
}
