/**
 * What counts as a delivery target.
 *
 * Deliberately permissive about *where* it points. A self-hosted Kelpie
 * legitimately posts to `http://automation.internal:8080`, so there is no
 * private-address filter here; adding one would break the self-hosted case to
 * defend a cloud that does not exist yet. The registration is admin-only and
 * the endpoint is the customer's own, which is what makes that acceptable
 * today. A hosted deployment needs egress filtering, and it belongs there
 * rather than in this check.
 */

export const DELIVERABLE_PROTOCOLS: readonly string[] = ['http:', 'https:']

export interface UrlProblem {
  readonly message: string
}

/**
 * @returns The problem with this URL, or undefined when it can be delivered to.
 *   A message rather than a boolean, so the `422` says which rule was broken.
 */
export function urlProblem(value: string): UrlProblem | undefined {
  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    // The only thing `new URL` throws for is a string it cannot parse, which is
    // exactly the answer wanted here.
    return { message: 'Expected an absolute URL, e.g. https://example.com/hooks/kelpie' }
  }

  if (!DELIVERABLE_PROTOCOLS.includes(parsed.protocol)) {
    return { message: 'Expected an http:// or https:// URL' }
  }

  // Credentials in the URL would be sent on every delivery and stored in
  // plaintext beside it, which is a secret the signing secret already replaces.
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { message: 'Remove the credentials from the URL; deliveries are signed instead' }
  }

  return undefined
}

export function isDeliverableUrl(value: string): boolean {
  return urlProblem(value) === undefined
}
