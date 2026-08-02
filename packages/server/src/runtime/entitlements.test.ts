import { describe, expect, it } from 'vitest'

import { AppError } from '../lib/errors.ts'
import { createEntitlementRegistry, limitFor, requireCapability } from './entitlements.ts'
import type { FlagCapability, LimitCapability } from './entitlements.ts'
import { ModuleBootError } from './order.ts'

const GMAIL: FlagCapability = {
  name: 'integrations.gmail',
  kind: 'flag',
  description: 'Sync mail from Gmail.',
}

const SEATS: LimitCapability = {
  name: 'seats.limit',
  kind: 'limit',
  description: 'How many people can belong to one workspace.',
}

describe('an assembly with no grant provider', () => {
  it('grants every flag', async () => {
    const registry = createEntitlementRegistry()
    registry.declare(GMAIL)

    expect(await registry.check('ws_1', GMAIL.name)).toEqual({ kind: 'flag', granted: true })
  })

  it('leaves every limit unlimited', async () => {
    const registry = createEntitlementRegistry()
    registry.declare(SEATS)

    expect(await limitFor(registry, 'ws_1', SEATS.name)).toBeNull()
  })

  it('lets a guarded action through', async () => {
    const registry = createEntitlementRegistry()
    registry.declare(GMAIL)

    await expect(requireCapability(registry, 'ws_1', GMAIL.name)).resolves.toBeUndefined()
  })
})

describe('declaring capabilities', () => {
  it('rejects the same name twice', () => {
    const registry = createEntitlementRegistry()
    registry.declare(GMAIL)

    expect(() => registry.declare(GMAIL)).toThrow(ModuleBootError)
  })

  it('refuses to check a name nobody declared', async () => {
    await expect(createEntitlementRegistry().check('ws_1', 'seats.limit')).rejects.toThrow(
      /No module declared the capability "seats.limit"/u,
    )
  })

  it('lists what was declared', () => {
    const registry = createEntitlementRegistry()
    registry.declare(GMAIL)
    registry.declare(SEATS)

    expect(registry.capabilities().map((capability) => capability.name)).toEqual([
      'integrations.gmail',
      'seats.limit',
    ])
  })
})

describe('a grant provider', () => {
  it('can deny a flag', async () => {
    const registry = createEntitlementRegistry()
    registry.declare(GMAIL)
    registry.provide(() => Promise.resolve({ kind: 'flag', granted: false }))

    let thrown: unknown

    try {
      await requireCapability(registry, 'ws_1', GMAIL.name)
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AppError)
    if (!(thrown instanceof AppError)) {
      throw thrown
    }

    expect(thrown.code).toBe('entitlement_required')
    expect(thrown.status).toBe(403)
  })

  it('can set a limit', async () => {
    const registry = createEntitlementRegistry()
    registry.declare(SEATS)
    registry.provide(() => Promise.resolve({ kind: 'limit', limit: 3 }))

    expect(await limitFor(registry, 'ws_1', SEATS.name)).toBe(3)
  })

  it('can answer differently per workspace', async () => {
    const registry = createEntitlementRegistry()
    registry.declare(SEATS)
    registry.provide((workspaceId) =>
      Promise.resolve(workspaceId === 'ws_paid' ? { kind: 'limit', limit: 50 } : { kind: 'limit', limit: 1 }),
    )

    expect(await limitFor(registry, 'ws_paid', SEATS.name)).toBe(50)
    expect(await limitFor(registry, 'ws_free', SEATS.name)).toBe(1)
  })

  it('falls through to the next provider when it has no opinion', async () => {
    const registry = createEntitlementRegistry()
    registry.declare(SEATS)
    registry.provide(() => Promise.resolve(undefined))
    registry.provide(() => Promise.resolve({ kind: 'limit', limit: 7 }))

    expect(await limitFor(registry, 'ws_1', SEATS.name)).toBe(7)
  })

  it('falls back to the open-source default when none has an opinion', async () => {
    const registry = createEntitlementRegistry()
    registry.declare(SEATS)
    registry.provide(() => Promise.resolve(undefined))

    expect(await limitFor(registry, 'ws_1', SEATS.name)).toBeNull()
  })

  it('lets the first opinion win', async () => {
    const registry = createEntitlementRegistry()
    registry.declare(SEATS)
    registry.provide(() => Promise.resolve({ kind: 'limit', limit: 2 }))
    registry.provide(() => Promise.resolve({ kind: 'limit', limit: 99 }))

    expect(await limitFor(registry, 'ws_1', SEATS.name)).toBe(2)
  })
})

describe('reading a capability as the wrong kind', () => {
  it('refuses to read a flag as a limit', async () => {
    const registry = createEntitlementRegistry()
    registry.declare(GMAIL)

    await expect(limitFor(registry, 'ws_1', GMAIL.name)).rejects.toThrow(/is a flag, not a limit/u)
  })
})
