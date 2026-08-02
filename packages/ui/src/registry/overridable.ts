import type { ComponentType } from 'react'

/**
 * The override escape hatch from `modules.md`: a module replaces a core
 * component outright. Prefer a slot; this is for the cases a slot cannot reach.
 *
 * A core component is replaceable only if it hands out a token, and the token
 * carries its props type. So an override that does not accept the props core
 * passes is a compile error, and a key nothing declared cannot be overridden at
 * all: there is no token to name it with.
 */

export interface Overridable<Props> {
  readonly key: string
  /** What renders when no module overrides it. Core's own component. */
  readonly fallback: ComponentType<Props>
}

/**
 * @param key Stable across releases. It is the name a module writes down.
 */
export function defineOverridable<Props>(
  key: string,
  fallback: ComponentType<Props>,
): Overridable<Props> {
  return { key, fallback }
}

export interface OverrideStore {
  set<Props>(token: Overridable<Props>, component: ComponentType<Props>): void
  /** @returns The override, or the token's own fallback when no module replaced it. */
  get<Props>(token: Overridable<Props>): ComponentType<Props>
  has(key: string): boolean
}

export function createOverrideStore(): OverrideStore {
  // One map holding components with different props types, so the value type is
  // the only one they share. `ComponentType<never>` looks like the tighter
  // choice and is not: `ComponentClass.defaultProps` is covariant in Props, so
  // nothing is assignable to it.
  const byKey = new Map<string, unknown>()

  return {
    set<Props>(token: Overridable<Props>, component: ComponentType<Props>): void {
      byKey.set(token.key, component)
    },

    get<Props>(token: Overridable<Props>): ComponentType<Props> {
      const override = byKey.get(token.key)

      if (override === undefined) {
        return token.fallback
      }

      // Sound by construction: the only writer is `set`, which accepts nothing
      // but a component for this token's own props.
      return override as ComponentType<Props>
    },

    has: (key) => byKey.has(key),
  }
}
