import type { CustomFieldObjectType, CustomFieldType, FormFieldType } from './values.ts'
import {
  ACCOUNT_TYPES,
  COMPANY_STAGES,
  CUSTOM_FIELD_OBJECT_TYPE_LABELS,
  CUSTOM_FIELD_TYPE_LABELS,
  FORM_FIELD_MAP_TARGET_LABELS,
  ICP_FITS,
  INFLUENCE_LEVELS,
  PERSON_CONSENT_TARGET,
  PERSON_EMAIL_TARGET,
  PREFERRED_CHANNELS,
  RELATIONSHIP_LEVELS,
  SIZE_BANDS,
} from './values.ts'

/**
 * Where a form field's answer may land on submit.
 *
 * Any string matching the catalog (standard fields, workspace custom fields,
 * `submission`, or `person.consent`). The legacy `FORM_FIELD_MAP_TARGETS` enum
 * is a starter subset; validation uses this module instead.
 */
export type FormFieldMapTarget = string

/** Object types that carry standard writable fields in the catalog. */
export const FORM_MAP_OBJECT_TYPES = [
  'person',
  'company',
  'position',
  'deal',
  'opportunity',
  'partnership',
  'enquiry',
  'raise',
] as const

export type FormMapObjectType = (typeof FORM_MAP_OBJECT_TYPES)[number]

export const FORM_MAP_OBJECT_TYPE_LABELS: Readonly<Record<FormMapObjectType, string>> = {
  person: 'Person',
  company: 'Company',
  position: 'Position',
  deal: 'Deal',
  opportunity: 'Opportunity',
  partnership: 'Partnership',
  enquiry: 'Enquiry',
  raise: 'Raise',
}

/** The value shape a mapped target expects from a submit answer. */
export type FormMapValueType =
  | 'text'
  | 'email'
  | 'phones'
  | 'tags'
  | 'string_array'
  | 'enum'
  | 'boolean'
  | 'date'
  | 'number'
  | 'currency'
  | 'url'
  | 'long_text'
  | 'consent'

export interface FormMapStandardField {
  readonly field: string
  readonly label: string
  readonly valueType: FormMapValueType
  /** Present for enum targets — the allowed wire values. */
  readonly enumValues?: readonly string[]
}

export interface FormMapTargetEntry {
  readonly target: string
  readonly objectType: FormMapObjectType | 'submission' | 'consent'
  readonly label: string
  readonly fieldKind: 'standard' | 'custom' | 'special'
  readonly valueType: FormMapValueType
  readonly enumValues?: readonly string[] | undefined
}

/** Minimal custom-field definition shape for building and labelling targets. */
export interface CustomFieldDefinitionRef {
  readonly objectType: CustomFieldObjectType
  readonly key: string
  readonly label: string
  readonly type: CustomFieldType
}

const PERSON_STANDARD_FIELDS: readonly FormMapStandardField[] = [
  { field: 'name', label: 'name', valueType: 'text' },
  { field: 'salutation', label: 'salutation', valueType: 'text' },
  { field: 'first_name', label: 'first name', valueType: 'text' },
  { field: 'last_name', label: 'last name', valueType: 'text' },
  { field: 'suffix', label: 'suffix', valueType: 'text' },
  { field: 'email', label: 'email', valueType: 'email' },
  { field: 'phones', label: 'phone', valueType: 'phones' },
  { field: 'timezone', label: 'timezone', valueType: 'text' },
  { field: 'location', label: 'location', valueType: 'text' },
  {
    field: 'preferred_channel',
    label: 'preferred channel',
    valueType: 'enum',
    enumValues: PREFERRED_CHANNELS,
  },
  {
    field: 'influence',
    label: 'influence',
    valueType: 'enum',
    enumValues: INFLUENCE_LEVELS,
  },
  {
    field: 'relationship',
    label: 'relationship',
    valueType: 'enum',
    enumValues: RELATIONSHIP_LEVELS,
  },
  { field: 'summary', label: 'summary', valueType: 'long_text' },
  { field: 'tags', label: 'tags', valueType: 'tags' },
  { field: 'do_not_contact', label: 'do not contact', valueType: 'boolean' },
]

const COMPANY_STANDARD_FIELDS: readonly FormMapStandardField[] = [
  { field: 'name', label: 'name', valueType: 'text' },
  { field: 'domain', label: 'domain', valueType: 'text' },
  { field: 'industry', label: 'industry', valueType: 'text' },
  { field: 'description', label: 'description', valueType: 'long_text' },
  {
    field: 'stage',
    label: 'stage',
    valueType: 'enum',
    enumValues: COMPANY_STAGES,
  },
  {
    field: 'size_band',
    label: 'size band',
    valueType: 'enum',
    enumValues: SIZE_BANDS,
  },
  { field: 'hq', label: 'hq', valueType: 'text' },
  { field: 'website', label: 'website', valueType: 'url' },
  {
    field: 'account_type',
    label: 'account type',
    valueType: 'enum',
    enumValues: ACCOUNT_TYPES,
  },
  {
    field: 'icp_fit',
    label: 'ICP fit',
    valueType: 'enum',
    enumValues: ICP_FITS,
  },
  { field: 'tech_stack', label: 'tech stack', valueType: 'string_array' },
  { field: 'summary', label: 'summary', valueType: 'long_text' },
  { field: 'tags', label: 'tags', valueType: 'tags' },
]

const POSITION_STANDARD_FIELDS: readonly FormMapStandardField[] = [
  { field: 'title', label: 'title', valueType: 'text' },
]

const DEAL_STANDARD_FIELDS: readonly FormMapStandardField[] = [
  { field: 'name', label: 'name', valueType: 'text' },
  { field: 'value_cents', label: 'value', valueType: 'number' },
  { field: 'currency', label: 'currency', valueType: 'text' },
  { field: 'expected_close', label: 'expected close', valueType: 'date' },
  { field: 'competitors', label: 'competitors', valueType: 'string_array' },
  { field: 'risks', label: 'risks', valueType: 'long_text' },
  { field: 'why_win', label: 'why win', valueType: 'long_text' },
  { field: 'summary', label: 'summary', valueType: 'long_text' },
  { field: 'tags', label: 'tags', valueType: 'tags' },
  { field: 'external_id', label: 'external id', valueType: 'text' },
]

const OPPORTUNITY_STANDARD_FIELDS: readonly FormMapStandardField[] = [
  { field: 'name', label: 'name', valueType: 'text' },
  { field: 'kind', label: 'kind', valueType: 'text' },
  { field: 'expected_close', label: 'expected close', valueType: 'date' },
  { field: 'summary', label: 'summary', valueType: 'long_text' },
  { field: 'tags', label: 'tags', valueType: 'tags' },
]

const PARTNERSHIP_STANDARD_FIELDS: readonly FormMapStandardField[] = [
  { field: 'name', label: 'name', valueType: 'text' },
  { field: 'kind', label: 'kind', valueType: 'text' },
  { field: 'next_touchpoint', label: 'next touchpoint', valueType: 'date' },
  { field: 'goals', label: 'goals', valueType: 'long_text' },
  { field: 'success_looks_like', label: 'success looks like', valueType: 'long_text' },
  { field: 'summary', label: 'summary', valueType: 'long_text' },
  { field: 'tags', label: 'tags', valueType: 'tags' },
]

const ENQUIRY_STANDARD_FIELDS: readonly FormMapStandardField[] = [
  { field: 'name', label: 'name', valueType: 'text' },
  { field: 'source', label: 'source', valueType: 'text' },
  { field: 'summary', label: 'summary', valueType: 'long_text' },
  { field: 'tags', label: 'tags', valueType: 'tags' },
]

const RAISE_STANDARD_FIELDS: readonly FormMapStandardField[] = [
  { field: 'name', label: 'name', valueType: 'text' },
  { field: 'check_size_cents', label: 'check size', valueType: 'number' },
  { field: 'currency', label: 'currency', valueType: 'text' },
  { field: 'thesis_fit', label: 'thesis fit', valueType: 'long_text' },
  { field: 'pass_reason', label: 'pass reason', valueType: 'long_text' },
  { field: 'expected_close', label: 'expected close', valueType: 'date' },
  { field: 'summary', label: 'summary', valueType: 'long_text' },
  { field: 'tags', label: 'tags', valueType: 'tags' },
]

/** Standard writable fields per object type, keyed by object. */
export const FORM_STANDARD_MAP_FIELDS: Readonly<
  Record<FormMapObjectType, readonly FormMapStandardField[]>
> = {
  person: PERSON_STANDARD_FIELDS,
  company: COMPANY_STANDARD_FIELDS,
  position: POSITION_STANDARD_FIELDS,
  deal: DEAL_STANDARD_FIELDS,
  opportunity: OPPORTUNITY_STANDARD_FIELDS,
  partnership: PARTNERSHIP_STANDARD_FIELDS,
  enquiry: ENQUIRY_STANDARD_FIELDS,
  raise: RAISE_STANDARD_FIELDS,
}

function standardFieldTarget(objectType: FormMapObjectType, field: FormMapStandardField): string {
  return `${objectType}.${field.field}`
}

function standardFieldLabel(objectType: FormMapObjectType, field: FormMapStandardField): string {
  return `${FORM_MAP_OBJECT_TYPE_LABELS[objectType]} · ${field.label}`
}

/** Every built-in map target entry, excluding workspace custom fields. */
export function listStandardMapTargetEntries(): readonly FormMapTargetEntry[] {
  const entries: FormMapTargetEntry[] = [
    {
      target: 'submission',
      objectType: 'submission',
      label: 'Submission only',
      fieldKind: 'special',
      valueType: 'text',
    },
    {
      target: PERSON_CONSENT_TARGET,
      objectType: 'consent',
      label: 'Person · consent',
      fieldKind: 'special',
      valueType: 'consent',
    },
  ]

  for (const objectType of FORM_MAP_OBJECT_TYPES) {
    for (const field of FORM_STANDARD_MAP_FIELDS[objectType]) {
      const entry: FormMapTargetEntry = {
        target: standardFieldTarget(objectType, field),
        objectType,
        label: standardFieldLabel(objectType, field),
        fieldKind: 'standard',
        valueType: field.valueType,
        ...(field.enumValues === undefined ? {} : { enumValues: field.enumValues }),
      }
      entries.push(entry)
    }
  }

  return entries
}

/** The wire target string for a workspace custom field definition. */
export function buildCustomMapTarget(objectType: CustomFieldObjectType, key: string): string {
  return `${objectType}.custom_fields.${key}`
}

/** A catalog entry for one workspace custom field definition. */
export function buildCustomMapTargetEntry(definition: CustomFieldDefinitionRef): FormMapTargetEntry {
  return {
    target: buildCustomMapTarget(definition.objectType, definition.key),
    objectType: definition.objectType,
    label: `${CUSTOM_FIELD_OBJECT_TYPE_LABELS[definition.objectType]} · ${definition.label} (custom)`,
    fieldKind: 'custom',
    valueType: customFieldTypeToMapValueType(definition.type),
  }
}

function customFieldTypeToMapValueType(type: CustomFieldType): FormMapValueType {
  switch (type) {
    case 'text':
      return 'text'
    case 'long_text':
      return 'long_text'
    case 'number':
      return 'number'
    case 'currency':
      return 'currency'
    case 'date':
      return 'date'
    case 'checkbox':
      return 'boolean'
    case 'select':
      return 'enum'
    case 'multi_select':
      return 'string_array'
    case 'url':
      return 'url'
  }
}

export interface ParsedFormMapTarget {
  readonly objectType: FormMapObjectType | 'submission' | 'consent'
  readonly fieldPath: string
  readonly isCustomField: boolean
  readonly customFieldKey?: string | undefined
}

/** Parses a map target string. Returns undefined when the shape is not recognised. */
export function parseFormMapTarget(target: string): ParsedFormMapTarget | undefined {
  if (target === 'submission') {
    return { objectType: 'submission', fieldPath: 'submission', isCustomField: false }
  }

  if (target === PERSON_CONSENT_TARGET) {
    return { objectType: 'consent', fieldPath: 'consent', isCustomField: false }
  }

  const customMatch = /^([a-z_]+)\.custom_fields\.([a-z][a-z0-9_]*)$/.exec(target)

  if (customMatch !== null) {
    const objectType = customMatch[1] as FormMapObjectType
    const key = customMatch[2]

    if (!FORM_MAP_OBJECT_TYPES.includes(objectType)) {
      return undefined
    }

    return {
      objectType,
      fieldPath: `custom_fields.${key}`,
      isCustomField: true,
      customFieldKey: key,
    }
  }

  const standardMatch = /^([a-z_]+)\.([a-z_]+)$/.exec(target)

  if (standardMatch === null) {
    return undefined
  }

  const objectType = standardMatch[1] as FormMapObjectType
  const field = standardMatch[2]

  if (field === undefined || !FORM_MAP_OBJECT_TYPES.includes(objectType)) {
    return undefined
  }

  const known = FORM_STANDARD_MAP_FIELDS[objectType].some((entry) => entry.field === field)

  if (!known) {
    return undefined
  }

  return { objectType, fieldPath: field, isCustomField: false }
}

/** True when more than one form field may share this target. */
export function isRepeatableMapTarget(target: string): boolean {
  return target === 'submission' || target === PERSON_CONSENT_TARGET
}

function findStandardEntry(target: string): FormMapTargetEntry | undefined {
  return listStandardMapTargetEntries().find((entry) => entry.target === target)
}

function findCustomEntry(
  target: string,
  definitions: readonly CustomFieldDefinitionRef[],
): FormMapTargetEntry | undefined {
  const parsed = parseFormMapTarget(target)

  if (parsed === undefined || !parsed.isCustomField || parsed.customFieldKey === undefined) {
    return undefined
  }

  const definition = definitions.find(
    (row) => row.objectType === parsed.objectType && row.key === parsed.customFieldKey,
  )

  return definition === undefined ? undefined : buildCustomMapTargetEntry(definition)
}

/** Resolves a target to its catalog entry, checking custom definitions when needed. */
export function resolveMapTargetEntry(
  target: string,
  customDefinitions: readonly CustomFieldDefinitionRef[] = [],
): FormMapTargetEntry | undefined {
  const standard = findStandardEntry(target)

  if (standard !== undefined) {
    return standard
  }

  return findCustomEntry(target, customDefinitions)
}

/** Display label for a map target. Falls back to the raw target string. */
export function labelForMapTarget(
  target: string,
  customDefinitions: readonly CustomFieldDefinitionRef[] = [],
): string {
  const legacy =
    FORM_FIELD_MAP_TARGET_LABELS[target as keyof typeof FORM_FIELD_MAP_TARGET_LABELS]

  if (legacy !== undefined) {
    return legacy
  }

  return resolveMapTargetEntry(target, customDefinitions)?.label ?? target
}

/** Merges the static catalog with workspace custom field definitions. */
export function listMapTargetEntries(
  customDefinitions: readonly CustomFieldDefinitionRef[] = [],
): readonly FormMapTargetEntry[] {
  return [
    ...listStandardMapTargetEntries(),
    ...customDefinitions.map((definition) => buildCustomMapTargetEntry(definition)),
  ]
}

/** True when the target is known in the catalog (standard or custom). */
export function isKnownMapTarget(
  target: string,
  customDefinitions: readonly CustomFieldDefinitionRef[] = [],
): boolean {
  return resolveMapTargetEntry(target, customDefinitions) !== undefined
}

/** Suggested form field control type for a map target. */
export function suggestedFormFieldType(
  target: string,
  customDefinitions: readonly CustomFieldDefinitionRef[] = [],
  current: FormFieldType = 'text',
): FormFieldType {
  if (target === PERSON_EMAIL_TARGET) {
    return 'email'
  }

  if (target === PERSON_CONSENT_TARGET) {
    return current === 'notice' ? 'notice' : 'consent'
  }

  const entry = resolveMapTargetEntry(target, customDefinitions)

  if (entry === undefined) {
    return current === 'consent' || current === 'notice' ? 'text' : current
  }

  switch (entry.valueType) {
    case 'email':
      return 'email'
    case 'long_text':
    case 'consent':
      return entry.valueType === 'consent'
        ? current === 'notice'
          ? 'notice'
          : 'consent'
        : 'textarea'
    case 'enum':
      return 'select'
    case 'boolean':
      return 'select'
    default:
      return current === 'consent' || current === 'notice' ? 'text' : current
  }
}

/** True when a form field type can reasonably collect an answer for this target. */
export function isCompatibleFormFieldType(
  formType: FormFieldType,
  target: string,
  customDefinitions: readonly CustomFieldDefinitionRef[] = [],
): boolean {
  if (target === PERSON_CONSENT_TARGET) {
    return formType === 'consent' || formType === 'notice'
  }

  if (formType === 'consent' || formType === 'notice') {
    return target === PERSON_CONSENT_TARGET
  }

  const entry = resolveMapTargetEntry(target, customDefinitions)

  if (entry === undefined) {
    return false
  }

  if (entry.objectType === 'submission') {
    return true
  }

  switch (entry.valueType) {
    case 'email':
      return formType === 'email' || formType === 'text'
    case 'boolean':
      return formType === 'select' || formType === 'text'
    case 'enum':
      return formType === 'select' || formType === 'text'
    case 'number':
    case 'currency':
    case 'date':
      return formType === 'text' || formType === 'select'
    case 'tags':
    case 'string_array':
    case 'phones':
      return formType === 'text' || formType === 'textarea' || formType === 'select'
    case 'url':
      return formType === 'text' || formType === 'email'
    case 'long_text':
      return formType === 'textarea' || formType === 'text'
    case 'consent':
      return false
    default:
      return formType === 'text' || formType === 'textarea' || formType === 'email' || formType === 'select'
  }
}

/** Meta line for the map-target search picker. */
export function metaForMapTargetEntry(
  entry: FormMapTargetEntry,
  customType?: CustomFieldType,
): string | undefined {
  if (entry.fieldKind === 'custom') {
    return customType === undefined
      ? 'custom'
      : `custom · ${CUSTOM_FIELD_TYPE_LABELS[customType]}`
  }

  if (entry.fieldKind === 'special') {
    return undefined
  }

  return entry.valueType
}

export { PERSON_CONSENT_TARGET, PERSON_EMAIL_TARGET }
