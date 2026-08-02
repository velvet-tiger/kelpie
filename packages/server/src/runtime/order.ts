import type { KelpieModule } from './module.ts'

/**
 * Boot failed while validating or registering modules. Carries every problem
 * found, so a misconfigured assembly reports all of them at once rather than
 * one per run.
 */
export class ModuleBootError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[], options?: ErrorOptions) {
    super(`Module boot failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`, options)
    this.name = 'ModuleBootError'
    this.problems = problems
  }
}

function findStructuralProblems(modules: readonly KelpieModule[], byId: ReadonlyMap<string, KelpieModule>): string[] {
  const problems: string[] = []
  const seen = new Set<string>()

  for (const module of modules) {
    if (seen.has(module.id)) {
      problems.push(`duplicate module id "${module.id}"`)
    }
    seen.add(module.id)
  }

  for (const module of modules) {
    for (const required of module.requires ?? []) {
      if (!byId.has(required)) {
        problems.push(`module "${module.id}" requires "${required}", which is not in the module list`)
      }
    }
  }

  return problems
}

/**
 * Sorts modules so each one registers after everything it `requires`.
 *
 * Independent modules keep their declared order, which is how `architecture.md`
 * pins the core module sequence. Nothing else about runtime behaviour may depend
 * on ordering.
 *
 * @throws ModuleBootError on duplicate ids, unmet `requires`, or a dependency cycle.
 */
export function orderModules(modules: readonly KelpieModule[]): readonly KelpieModule[] {
  const byId = new Map(modules.map((module) => [module.id, module]))
  const problems = findStructuralProblems(modules, byId)

  if (problems.length > 0) {
    throw new ModuleBootError(problems)
  }

  const ordered: KelpieModule[] = []
  const progress = new Map<string, 'visiting' | 'done'>()

  function visit(module: KelpieModule, trail: readonly string[]): void {
    const state = progress.get(module.id)

    if (state === 'done') {
      return
    }

    if (state === 'visiting') {
      throw new ModuleBootError([`module dependency cycle: ${[...trail, module.id].join(' -> ')}`])
    }

    progress.set(module.id, 'visiting')

    for (const required of module.requires ?? []) {
      const dependency = byId.get(required)

      if (dependency !== undefined) {
        visit(dependency, [...trail, module.id])
      }
    }

    progress.set(module.id, 'done')
    ordered.push(module)
  }

  for (const module of modules) {
    visit(module, [])
  }

  return ordered
}
