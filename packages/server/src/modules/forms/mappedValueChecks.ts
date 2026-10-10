import { parseFormMapTarget } from '@kelpie/schemas'
import type { FormMapObjectType } from '@kelpie/schemas'
import type { z } from 'zod'

import { updateBody as companyUpdateBody } from '../companies/routes.ts'
import { updateBody as dealUpdateBody } from '../deals/routes.ts'
import { updateBody as enquiryUpdateBody } from '../enquiries/routes.ts'
import { updateBody as opportunityUpdateBody } from '../opportunities/routes.ts'
import { updateBody as partnershipUpdateBody } from '../partnerships/routes.ts'
import { updateBody as personUpdateBody } from '../people/routes.ts'
import { updateBody as positionUpdateBody } from '../positions/routes.ts'
import { updateBody as raiseUpdateBody } from '../raises/routes.ts'
import { parseStandardAnswer } from './applyMappedFields.ts'
import type { MappedAnswers } from './mapping.ts'

/**
 * The value rules for what a submit maps onto a record.
 *
 * A mapped answer is written by somebody with no credentials, so it gets the
 * check a member's own `PATCH` gets, from the same schema: each record's
 * `updateBody`. No rule is written a second time here. A value that schema
 * refuses is left out of the write. It is never a failed submit: the answer
 * stays on the stored submission as it was typed, and the action log says
 * which target was skipped.
 */

/** A mapped answer left out of the write, and the schema's reason. */
export interface RefusedMappedValue {
  readonly target: string
  readonly reason: string
}

export interface CheckedMappedAnswers {
  /** The answers a record's own `PATCH` would take. Only these are written. */
  readonly accepted: MappedAnswers
  readonly refused: readonly RefusedMappedValue[]
}

/**
 * The `PATCH` body of each record a submit writes.
 *
 * `event` has none here on purpose: the catalog offers event targets, and no
 * submit writes one, so there is no write to guard.
 */
const UPDATE_BODIES: Readonly<Record<FormMapObjectType, z.ZodType | undefined>> = {
  person: personUpdateBody,
  company: companyUpdateBody,
  position: positionUpdateBody,
  deal: dealUpdateBody,
  opportunity: opportunityUpdateBody,
  partnership: partnershipUpdateBody,
  enquiry: enquiryUpdateBody,
  raise: raiseUpdateBody,
  event: undefined,
}

/**
 * The value a submit would store for one target, in the shape the `PATCH`
 * body takes it.
 *
 * @returns undefined when the text cannot be read as the target's type, for
 *   example a number field given words.
 */
function writtenValue(objectType: FormMapObjectType, field: string, raw: string): unknown {
  // The core capture stores the phone answer whole, as the one entry of an
  // empty list. It is not split on commas like the other list targets.
  if (objectType === 'person' && field === 'phones') {
    return [raw]
  }

  return parseStandardAnswer(objectType, field, raw)
}

/**
 * Why a record's `PATCH` would refuse this answer for this target.
 *
 * @returns undefined when the value is one the `PATCH` takes, or when the
 *   target has no rule to apply: `submission`, an address part (the address
 *   schema sets no limit on a part) and a custom field (its own service checks
 *   it against the definition when it is written).
 */
export function mappedValueProblem(target: string, raw: string): string | undefined {
  const parsed = parseFormMapTarget(target)

  if (
    parsed === undefined ||
    parsed.isCustomField ||
    parsed.objectType === 'submission' ||
    parsed.objectType === 'consent' ||
    parsed.objectType === 'lists' ||
    parsed.fieldPath.startsWith('address.')
  ) {
    return undefined
  }

  const body = UPDATE_BODIES[parsed.objectType]

  if (body === undefined) {
    return undefined
  }

  const value = writtenValue(parsed.objectType, parsed.fieldPath, raw)

  // An absent key passes a partial body, so an unreadable value has to be
  // refused here and not handed to the schema.
  if (value === undefined) {
    return 'Not a value this field takes'
  }

  const result = body.safeParse({ [parsed.fieldPath]: value })

  return result.success ? undefined : (result.error.issues[0]?.message ?? 'Not a value this field takes')
}

/** Splits mapped answers into the ones that are written and the ones that are not. */
export function checkMappedAnswers(mapped: MappedAnswers): CheckedMappedAnswers {
  const accepted: MappedAnswers = {}
  const refused: RefusedMappedValue[] = []

  for (const [target, raw] of Object.entries(mapped)) {
    const reason = mappedValueProblem(target, raw)

    if (reason === undefined) {
      accepted[target] = raw
    } else {
      refused.push({ target, reason })
    }
  }

  return { accepted, refused }
}

/** Why a mapped answer was left off a record the submit matched and did not create. */
export const EXISTING_RECORD_REASON = 'The record already existed'

/**
 * The mapped targets that name a field of one record type.
 *
 * What the caller logs as not written when the record was already in the
 * workspace. A submit writes a visitor's value only on a record it creates:
 * the match is a claim (an address or a company name anybody can type), so it
 * gives a stranger no way to change a record the team already has.
 *
 * @param except Targets to leave out, for example the one the match was made on.
 */
export function mappedTargetsOf(
  mapped: MappedAnswers,
  objectType: FormMapObjectType,
  except: readonly string[] = [],
): readonly string[] {
  return Object.keys(mapped).filter(
    (target) => !except.includes(target) && parseFormMapTarget(target)?.objectType === objectType,
  )
}
