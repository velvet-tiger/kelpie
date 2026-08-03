/** Small conversions the detail pages share, kept out of their markup. */

/** `decision_maker` reads as `decision maker` in a label. The stored value never changes. */
export function labelize(value: string): string {
  return value.replace(/_/gu, ' ')
}

/** A fixed value set as `InlineEdit` select options. */
export function toOptions(
  values: readonly string[],
): readonly { readonly value: string; readonly label: string }[] {
  return values.map((value) => ({ value, label: labelize(value) }))
}

/** The comma-separated tag box, back into the array the API takes. */
export function toTags(value: string): readonly string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}
