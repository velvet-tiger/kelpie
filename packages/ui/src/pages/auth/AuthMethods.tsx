import { Fragment } from 'react'

import { useAuthMethods } from '../../registry/context.ts'
import type { AuthMethodContext } from '../../registry/contributions.ts'

/**
 * The `auth.methods` slot, rendered by the signed-out pages beside their form.
 *
 * Nothing is drawn around the contributions: no divider, no "or" rule. Whether
 * a module has anything to show is decided at run time (a sign-in module with
 * no provider configured renders nothing), so core framing would leave a
 * heading over an empty space. A module that draws buttons draws its own
 * divider with `AuthDivider`.
 */
export function AuthMethods({ intent, next }: AuthMethodContext): React.JSX.Element | null {
  const methods = useAuthMethods()

  if (methods.length === 0) {
    return null
  }

  return (
    <div className="mt-4 space-y-2">
      {methods.map((method) => (
        <Fragment key={method.id}>{method.render({ intent, next })}</Fragment>
      ))}
    </div>
  )
}
