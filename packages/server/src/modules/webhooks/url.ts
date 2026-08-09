import { endpointUrlProblem } from '../../lib/url.ts'
import type { UrlProblem } from '../../lib/url.ts'

/**
 * What counts as a delivery target. The shared rules live in `lib/url.ts`;
 * this binds the one webhook-specific part, the credentials advice.
 */

export type { UrlProblem } from '../../lib/url.ts'
export { DELIVERABLE_PROTOCOLS } from '../../lib/url.ts'

export function urlProblem(value: string): UrlProblem | undefined {
  return endpointUrlProblem(
    value,
    'Remove the credentials from the URL; deliveries are signed instead',
  )
}

export function isDeliverableUrl(value: string): boolean {
  return urlProblem(value) === undefined
}
