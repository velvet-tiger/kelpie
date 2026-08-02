import type { ReactNode } from 'react'

import { UiExtensionContext } from './context.ts'
import type { UiExtensions } from './registry.ts'

export interface UiExtensionProviderProps {
  readonly extensions: UiExtensions
  readonly children: ReactNode
}

/**
 * Puts a built registry in reach of the tree below it. The assembly wraps its
 * root in one of these; nothing else should need to.
 */
export function UiExtensionProvider({
  extensions,
  children,
}: UiExtensionProviderProps): React.JSX.Element {
  return <UiExtensionContext value={extensions}>{children}</UiExtensionContext>
}
