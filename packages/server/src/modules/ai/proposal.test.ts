import { describe, expect, it } from 'vitest'

import { MAX_OPERATIONS } from './rules.ts'
import {
  OPERATIONS_BY_TARGET,
  UPDATE_FIELD_ALLOWLIST,
  proposalJsonSchemaFor,
  validateProposal,
} from './proposal.ts'

/**
 * Pure vocabulary and allowlist tests. Runs without a database.
 */

describe('validateProposal', () => {
  it('accepts a well-formed proposal for a person target', () => {
    const result = validateProposal('person', {
      summary: 'Enriched the profile from public sources.',
      operations: [
        {
          kind: 'update_target',
          fields: { summary: 'Senior engineer at Acme.', tags: ['warm', 'referral'] },
        },
        { kind: 'append_note', body: 'Prefers email replies.', pinned: false },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.proposal.summary).toBe('Enriched the profile from public sources.')
    expect(result.proposal.operations).toHaveLength(2)
    expect(result.droppedFields).toEqual([])
    expect(result.droppedOperationKinds).toEqual([])
  })

  it('strips fields not on the allowlist and reports them', () => {
    const result = validateProposal('person', {
      summary: 'ok',
      operations: [
        {
          kind: 'update_target',
          fields: {
            summary: 'Kept.',
            stage_id: 'stg_evil',
            email: 'nope@example.com',
          },
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [operation] = result.proposal.operations
    if (operation?.kind !== 'update_target') {
      throw new Error('expected update_target')
    }
    expect(Object.keys(operation.fields).sort()).toEqual(['summary'])
    expect([...result.droppedFields].sort()).toEqual(['email', 'stage_id'])
  })

  it('drops an update_target whose fields are all stripped', () => {
    const result = validateProposal('person', {
      summary: 'ok',
      operations: [{ kind: 'update_target', fields: { stage_id: 'stg_x' } }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.proposal.operations).toEqual([])
    expect(result.droppedFields).toEqual(['stage_id'])
  })

  it('drops operation kinds not allowed for the target and reports them', () => {
    const result = validateProposal('handbook', {
      summary: 'ok',
      operations: [
        { kind: 'update_target', fields: { summary: 'no' } },
        { kind: 'append_note', body: 'a note', pinned: false },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.proposal.operations).toHaveLength(1)
    expect(result.proposal.operations[0]?.kind).toBe('append_note')
    expect(result.droppedOperationKinds).toEqual(['update_target'])
  })

  it('reports parse issues when JSON does not match the schema', () => {
    const result = validateProposal('person', {
      operations: [{ kind: 'append_note', body: '', pinned: false }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.length).toBeGreaterThan(0)
    // Missing summary and empty body are both surfaced.
    expect(result.issues.join('\n')).toMatch(/summary/)
  })

  it('rejects more than MAX_OPERATIONS operations', () => {
    const operations = Array.from({ length: MAX_OPERATIONS + 1 }, () => ({
      kind: 'append_note' as const,
      body: 'n',
      pinned: false,
    }))
    const result = validateProposal('person', { summary: 'many', operations })
    expect(result.ok).toBe(false)
  })
})

describe('OPERATIONS_BY_TARGET and UPDATE_FIELD_ALLOWLIST', () => {
  it('names an update tool set for every write-capable target', () => {
    // A target that allows update_target must have at least one field allowed.
    for (const target of Object.keys(OPERATIONS_BY_TARGET) as (keyof typeof OPERATIONS_BY_TARGET)[]) {
      const kinds = OPERATIONS_BY_TARGET[target]
      const fields = UPDATE_FIELD_ALLOWLIST[target]
      if (kinds.includes('update_target')) {
        expect(fields.length).toBeGreaterThan(0)
      }
    }
  })

  it('does not allow update_target on handbook, role, candidate, or workspace targets', () => {
    for (const target of ['handbook', 'role', 'candidate', 'workspace'] as const) {
      expect(OPERATIONS_BY_TARGET[target]).not.toContain('update_target')
      expect(UPDATE_FIELD_ALLOWLIST[target]).toEqual([])
    }
  })
})

describe('proposalJsonSchemaFor', () => {
  it('renders a JSON schema every allowed target the model can read', () => {
    for (const target of Object.keys(OPERATIONS_BY_TARGET) as (keyof typeof OPERATIONS_BY_TARGET)[]) {
      const schema = proposalJsonSchemaFor(target)
      expect(schema).toHaveProperty('properties')
    }
  })
})
