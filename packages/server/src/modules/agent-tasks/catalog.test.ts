import { AGENT_TASK_TARGET_TYPES } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { AGENT_TASK_DEFINITIONS, SHARED_WRITE_POLICY, findTask, tasksFor } from './catalog.ts'

describe('agent task catalog', () => {
  it('carries the 75 tasks agent-tasks.md names, with unique ids', () => {
    expect(AGENT_TASK_DEFINITIONS).toHaveLength(75)
    expect(new Set(AGENT_TASK_DEFINITIONS.map((task) => task.id)).size).toBe(75)
  })

  it('prefixes every id with its target type', () => {
    for (const task of AGENT_TASK_DEFINITIONS) {
      const [prefix] = task.id.split('.')

      expect(task.targetTypes).toEqual([prefix])
    }
  })

  it('covers every target type', () => {
    for (const targetType of AGENT_TASK_TARGET_TYPES) {
      expect(tasksFor(targetType).length).toBeGreaterThan(0)
    }
  })

  it('requires the agent FAQ on every task', () => {
    for (const task of AGENT_TASK_DEFINITIONS) {
      expect(task.handbookSlugs).toContain('agent-faq')
    }
  })

  it('applies the shared write policy', () => {
    for (const task of AGENT_TASK_DEFINITIONS) {
      expect(task.writePolicy).toBe(SHARED_WRITE_POLICY)
    }
  })

  it('finds a task by id and answers undefined for a stranger', () => {
    expect(findTask('company.enrich')?.label).toBe('Enrich company')
    expect(findTask('company.does_not_exist')).toBeUndefined()
  })

  it('narrows tasksFor to the asked type', () => {
    const roleTasks = tasksFor('role')

    expect(roleTasks.map((task) => task.id)).toEqual(['role.compare_shortlist'])
  })
})
