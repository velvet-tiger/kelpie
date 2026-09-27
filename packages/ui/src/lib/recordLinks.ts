import type { RecordReference, RecordReferenceType, RecordTargetType } from '@kelpie/schemas'

/**
 * Where each kind of record lives. A Candidate has no page of its own: it is
 * reached through its Role. An Attendance is reached through its Event. A Note,
 * Decision or Plan item is reached on the page of the record it is on; see
 * `attachedHref`.
 */
const ROUTES: Readonly<Record<RecordReferenceType, string | undefined>> = {
  person: '/people',
  company: '/companies',
  deal: '/deals',
  opportunity: '/opportunities',
  partnership: '/partnerships',
  raise: '/fundraising',
  enquiry: '/enquiries',
  candidate: undefined,
  event: '/events',
  attendance: undefined,
  role: '/hiring',
  handbook_page: '/handbook',
  list: '/lists',
  form: '/forms',
  note: undefined,
  decision: undefined,
  plan_item: undefined,
}

/**
 * @returns The record's page, or undefined when it has none. A row without a
 *   link renders as plain text rather than as a link to nowhere.
 */
export function targetHref(targetType: RecordReferenceType, targetId: string): string | undefined {
  const route = ROUTES[targetType]

  return route === undefined ? undefined : `${route}/${targetId}`
}

/**
 * A Note, Decision or Plan item: the page of the record it is on, with its own
 * id as the fragment, which the panel on that page scrolls to and highlights.
 */
export function attachedHref(
  id: string,
  parent: { readonly type: RecordTargetType; readonly id: string },
): string | undefined {
  const page = targetHref(parent.type, parent.id)

  return page === undefined ? undefined : `${page}#${id}`
}

/** Where a cited record opens, or undefined when it has nowhere to open. */
export function referenceHref(reference: RecordReference): string | undefined {
  return reference.parent === null
    ? targetHref(reference.targetType, reference.targetId)
    : attachedHref(reference.targetId, reference.parent)
}
