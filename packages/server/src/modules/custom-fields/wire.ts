/**
 * Renders the stored `custom_fields` for a record's wire body.
 *
 * Every value type serialises as itself with one exception: currency lives in
 * the store as `{amountCents, currency}` (camelCase, from
 * `customFieldValuesSchema`'s transform) and goes back over the wire as
 * `{amount_cents, currency}` per the api.md snake_case rule. Every record
 * module's response mapper calls this from one place so the two shapes cannot
 * drift.
 */
export function renderCustomFieldsForWire(
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'amountCents' in value &&
      'currency' in value
    ) {
      out[key] = {
        amount_cents: (value as { amountCents: number }).amountCents,
        currency: (value as { currency: string }).currency,
      }
    } else {
      out[key] = value
    }
  }
  return out
}
