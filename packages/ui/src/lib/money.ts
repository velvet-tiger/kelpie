/**
 * How the app writes a deal's value. `api.md` stores money as integer cents plus
 * an ISO 4217 code; the board and the sidebar both render whole units, as the
 * mockup did.
 */
export function formatMoney(valueCents: number, currency: string | null): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency ?? 'USD',
    maximumFractionDigits: 0,
  }).format(valueCents / 100)
}
