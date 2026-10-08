import { AGENT_TASK_TARGET_TYPES } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { AGENT_TASK_DEFINITIONS, SHARED_WRITE_POLICY, findTask, tasksFor } from './catalog.ts'

describe('agent task catalog', () => {
  it('carries the 79 tasks, with unique ids', () => {
    expect(AGENT_TASK_DEFINITIONS).toHaveLength(79)
    expect(new Set(AGENT_TASK_DEFINITIONS.map((task) => task.id)).size).toBe(79)
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

  /**
   * The lists are written out so that granting a task either write is a
   * change somebody has to make here on purpose.
   */
  it('grants a Decision to the tasks whose instructions ask for one, and to no other', () => {
    const granted = AGENT_TASK_DEFINITIONS.filter((task) => task.mayCreateDecision)

    expect(granted.map((task) => task.id)).toEqual([
      'person.capture_decision',
      'person.log_transcript',
      'company.capture_decision',
      'deal.capture_decision',
      'deal.log_transcript',
      'enquiry.capture_decision',
      'enquiry.log_transcript',
      'opportunity.capture_decision',
      'opportunity.log_transcript',
      'partnership.capture_decision',
      'partnership.log_transcript',
      'raise.capture_pass',
      'raise.capture_decision',
      'raise.log_transcript',
    ])

    for (const task of granted) {
      expect(task.instructions).toMatch(/Decision/u)
    }
  })

  it('grants a pin to the tasks whose instructions ask for one, and to no other', () => {
    const granted = AGENT_TASK_DEFINITIONS.filter((task) => task.mayPin)

    expect(granted.map((task) => task.id)).toEqual([
      'person.distill_notes',
      'company.account_brief',
      'company.distill_notes',
      'deal.distill_notes',
      'opportunity.distill_notes',
      'partnership.distill_notes',
      'raise.distill_notes',
      'candidate.summarise_interview',
      'workspace.add_person',
    ])

    for (const task of granted) {
      expect(task.instructions).toMatch(/\bPin |pinned Note/u)
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
