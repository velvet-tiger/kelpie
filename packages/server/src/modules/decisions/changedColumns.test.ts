import { describe, expect, it } from 'vitest'

import type { DecisionRecord } from './repository.ts'
import { changedColumns } from './service.ts'

/**
 * `changedColumns` decides what an update writes and whether it changes the
 * text. A column it names wrongly is written over a newer value, or lets a
 * rewrite of a confirmed decision through as "no change".
 */

const stored: DecisionRecord = {
  id: 'dec_1',
  workspaceId: 'ws_1',
  targetType: 'person',
  targetId: 'per_1',
  body: 'We give Acme 10% off.',
  rationale: 'They asked first.',
  decidedAt: new Date('2026-07-01T09:30:00.000Z'),
  ownerId: 'mem_1',
  dueAt: null,
  origin: 'member',
  confirmedAt: new Date('2026-07-01T09:30:00.000Z'),
  confirmedById: 'mem_1',
  createdAt: new Date('2026-07-01T09:30:00.000Z'),
  updatedAt: new Date('2026-07-01T09:30:00.000Z'),
  searchVector: '',
}

describe('changedColumns', () => {
  it('names nothing for a request that sends what is stored', () => {
    expect(
      changedColumns(stored, {
        body: 'We give Acme 10% off.',
        rationale: 'They asked first.',
        // The same instant in another object.
        decidedAt: new Date('2026-07-01T09:30:00.000Z'),
        ownerId: 'mem_1',
        dueAt: null,
      }),
    ).toEqual({})
  })

  it('names nothing for a field the request does not send', () => {
    expect(changedColumns(stored, {})).toEqual({})
  })

  it('names only the columns that differ, and leaves the others out of the write', () => {
    const dueAt = new Date('2026-09-01T00:00:00.000Z')

    expect(changedColumns(stored, { body: 'We give Acme 10% off.', dueAt })).toEqual({ dueAt })
    expect(changedColumns(stored, { ownerId: null, rationale: 'They asked first.' })).toEqual({ ownerId: null })
  })

  it('compares text exactly: white space alone is a change', () => {
    expect(changedColumns(stored, { body: 'We give Acme 10% off. ' })).toEqual({ body: 'We give Acme 10% off. ' })
    expect(changedColumns(stored, { body: 'We give Acme  10% off.' })).toEqual({ body: 'We give Acme  10% off.' })
    expect(changedColumns(stored, { rationale: null })).toEqual({ rationale: null })
  })

  it('compares a date with a stored null, and a null with a stored date', () => {
    const dueAt = new Date('2026-09-01T00:00:00.000Z')

    expect(changedColumns(stored, { dueAt })).toEqual({ dueAt })
    expect(changedColumns({ ...stored, dueAt }, { dueAt: null })).toEqual({ dueAt: null })
    expect(changedColumns({ ...stored, dueAt }, { dueAt: new Date(dueAt.getTime()) })).toEqual({})
  })
})
