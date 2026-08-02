import { describe, expect, it } from 'vitest'

import type { KelpieModule } from './module.ts'
import { ModuleBootError, orderModules } from './order.ts'

function stubModule(id: string, requires?: readonly string[]): KelpieModule {
  return {
    id,
    ...(requires === undefined ? {} : { requires }),
    register: () => Promise.resolve(),
  }
}

function idsOf(modules: readonly KelpieModule[]): readonly string[] {
  return modules.map((module) => module.id)
}

describe('orderModules', () => {
  it('keeps the declared order when nothing depends on anything', () => {
    const ordered = orderModules([stubModule('workspace'), stubModule('auth'), stubModule('people')])

    expect(idsOf(ordered)).toEqual(['workspace', 'auth', 'people'])
  })

  it('registers a module after everything it requires', () => {
    const ordered = orderModules([stubModule('deals', ['companies']), stubModule('companies')])

    expect(idsOf(ordered)).toEqual(['companies', 'deals'])
  })

  it('resolves a chain of requires', () => {
    const ordered = orderModules([
      stubModule('billing', ['workspace']),
      stubModule('deals', ['companies']),
      stubModule('companies', ['workspace']),
      stubModule('workspace'),
    ])

    expect(idsOf(ordered)).toEqual(['workspace', 'billing', 'companies', 'deals'])
  })

  it('rejects a duplicate module id', () => {
    expect(() => orderModules([stubModule('people'), stubModule('people')])).toThrow(ModuleBootError)
  })

  it('names the module and the dependency when a require is unmet', () => {
    let thrown: unknown

    try {
      orderModules([stubModule('gmail-sync', ['integrations'])])
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ModuleBootError)
    if (!(thrown instanceof ModuleBootError)) {
      throw thrown
    }

    expect(thrown.problems).toEqual([
      'module "gmail-sync" requires "integrations", which is not in the module list',
    ])
  })

  it('reports every structural problem at once', () => {
    let thrown: unknown

    try {
      orderModules([stubModule('people'), stubModule('people'), stubModule('deals', ['missing'])])
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ModuleBootError)
    if (!(thrown instanceof ModuleBootError)) {
      throw thrown
    }

    expect(thrown.problems).toHaveLength(2)
  })

  it('rejects a dependency cycle and shows the trail', () => {
    let thrown: unknown

    try {
      orderModules([stubModule('a', ['b']), stubModule('b', ['a'])])
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ModuleBootError)
    if (!(thrown instanceof ModuleBootError)) {
      throw thrown
    }

    expect(thrown.problems[0]).toContain('cycle')
    expect(thrown.problems[0]).toContain('a -> b -> a')
  })

  it('rejects a module that requires itself', () => {
    expect(() => orderModules([stubModule('a', ['a'])])).toThrow(ModuleBootError)
  })
})
