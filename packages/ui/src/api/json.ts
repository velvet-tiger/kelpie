/** Narrows parsed JSON to something with readable properties, without casting. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
