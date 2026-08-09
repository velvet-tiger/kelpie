import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { definedFields, idSchema, nullableTimestampSchema, recordTimestamps, timestampSchema } from './wire.ts'

describe('idSchema', () => {
  it('accepts any non-empty string', () => {
    expect(idSchema.parse('person_01hx')).toBe('person_01hx')
  })

  it('rejects an empty string', () => {
    expect(() => idSchema.parse('')).toThrow()
  })
})

describe('timestampSchema', () => {
  it('reads an ISO 8601 UTC string into a Date', () => {
    const parsed = timestampSchema.parse('2026-08-02T01:00:00.000Z')

    expect(parsed).toBeInstanceOf(Date)
    expect(parsed.toISOString()).toBe('2026-08-02T01:00:00.000Z')
  })

  it('rejects a non-ISO string', () => {
    expect(() => timestampSchema.parse('2 August 2026')).toThrow()
  })

  it('rejects null', () => {
    expect(() => timestampSchema.parse(null)).toThrow()
  })
})

describe('nullableTimestampSchema', () => {
  it('leaves null as null rather than an epoch', () => {
    expect(nullableTimestampSchema.parse(null)).toBeNull()
  })

  it('reads a present value the same way timestampSchema does', () => {
    const parsed = nullableTimestampSchema.parse('2026-08-02T01:00:00.000Z')

    expect(parsed).toEqual(new Date('2026-08-02T01:00:00.000Z'))
  })
})

describe('recordTimestamps', () => {
  it('parses created_at and updated_at into the RecordTimestamps shape a transform reads', () => {
    const schema = z.object(recordTimestamps)

    const parsed = schema.parse({
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-02T00:00:00.000Z',
    })

    expect(parsed.created_at).toEqual(new Date('2026-08-01T00:00:00.000Z'))
    expect(parsed.updated_at).toEqual(new Date('2026-08-02T00:00:00.000Z'))
  })
})

describe('definedFields', () => {
  it('drops undefined values', () => {
    expect(definedFields({ name: 'Ada', email: undefined })).toEqual({ name: 'Ada' })
  })

  it('keeps null, because null is the clear-this-field signal a PATCH sends', () => {
    expect(definedFields({ email: null })).toEqual({ email: null })
  })

  it('keeps falsy values that are not undefined', () => {
    expect(definedFields({ count: 0, active: false, name: '' })).toEqual({
      count: 0,
      active: false,
      name: '',
    })
  })

  it('returns an empty object when every field is undefined', () => {
    expect(definedFields({ name: undefined, email: undefined })).toEqual({})
  })
})
