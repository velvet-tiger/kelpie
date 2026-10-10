import { AGENT_TASK_TARGET_TYPES } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import type { McpTool } from '../../runtime/module.ts'
import { createTestApp } from '../../testing/app.ts'
import { AGENT_TASK_DEFINITIONS } from '../agent-tasks/catalog.ts'
import { runScopes, targetReadScope } from '../agent-tasks/scopes.ts'
import { coreModules } from '../core.ts'
import { TARGET_UPDATE_TOOL } from './executor.ts'
import { OPERATIONS_BY_TARGET } from './proposal.ts'
import type { OperationKind } from './proposal.ts'

/**
 * Core asks a scoped key that starts a run for the scopes of what the run may
 * write (`agent-tasks/scopes.ts`). What a hosted run may write is decided
 * here, in `OPERATIONS_BY_TARGET` and the tools the executor calls. The two
 * lists are in two modules, so this test is what keeps them the same.
 */

/** The write tool the executor calls for each operation kind. `update_target` depends on the target. */
const OPERATION_TOOLS: Readonly<Record<Exclude<OperationKind, 'update_target'>, string>> = {
  append_note: 'notes_create',
  pin_note: 'notes_update',
  create_plan: 'plan_items_create',
  create_decision: 'decisions_create',
  create_position: 'positions_create',
}

describe('the scopes a run needs and the writes a hosted run applies', () => {
  async function toolScopes(): Promise<ReadonlyMap<string, string>> {
    // Only the tool declarations are read, so no database is needed.
    const harness = await createTestApp({ modules: coreModules })

    return new Map(harness.contributions.mcpTools.map((tool: McpTool) => [tool.name, tool.scope]))
  }

  it('are the same list, for every task on every target type it applies to', async () => {
    const scopes = await toolScopes()

    function scopeOf(toolName: string): string {
      const scope = scopes.get(toolName)

      if (scope === undefined) {
        throw new Error(`no tool named ${toolName} is registered`)
      }

      return scope
    }

    for (const definition of AGENT_TASK_DEFINITIONS) {
      for (const targetType of definition.targetTypes) {
        const applied = new Set<string>()

        for (const kind of OPERATIONS_BY_TARGET[targetType]) {
          if (kind === 'update_target') {
            const toolName = TARGET_UPDATE_TOOL[targetType]

            if (toolName !== undefined) {
              applied.add(scopeOf(toolName))
            }
          } else if (kind !== 'create_decision' || definition.mayCreateDecision) {
            applied.add(scopeOf(OPERATION_TOOLS[kind]))
          }
        }

        const [read, ...writes] = runScopes(definition, targetType)

        expect(read, `${definition.id} on ${targetType}`).toBe(targetReadScope(targetType))
        expect([...new Set(writes)].sort(), `${definition.id} on ${targetType}`).toEqual([...applied].sort())
      }
    }
  })

  it('names a read scope for every target type', () => {
    for (const targetType of AGENT_TASK_TARGET_TYPES) {
      expect(targetReadScope(targetType), targetType).toMatch(/:read$/u)
    }
  })
})
