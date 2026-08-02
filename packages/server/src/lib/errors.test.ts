import { describe, expect, it } from 'vitest'

import { AppError, describeThrown, internalErrorBody, toErrorBody, toErrorDetails } from './errors.ts'

describe('AppError', () => {
  it('maps each code to the status api.md documents', () => {
    expect(new AppError('validation_failed', 'bad').status).toBe(422)
    expect(new AppError('conflict', 'clash').status).toBe(409)
    expect(AppError.notFound().status).toBe(404)
    expect(AppError.unauthorized().status).toBe(401)
  })
})

describe('toErrorBody', () => {
  it('omits details when the error carries none', () => {
    expect(toErrorBody(AppError.notFound())).toEqual({
      error: { code: 'not_found', message: 'Not found' },
    })
  })

  it('includes field-level details when present', () => {
    const error = AppError.validationFailed('email is required', [
      { field: 'email', message: 'Missing required field' },
    ])

    expect(toErrorBody(error)).toEqual({
      error: {
        code: 'validation_failed',
        message: 'email is required',
        details: [{ field: 'email', message: 'Missing required field' }],
      },
    })
  })
})

describe('toErrorDetails', () => {
  it('reports a field problem against its path', () => {
    expect(toErrorDetails([{ path: ['social_profiles', 0, 'url'], message: 'Required' }])).toEqual([
      { field: 'social_profiles.0.url', message: 'Required' },
    ])
  })

  /** Zod raises this at the object, so without the keys the client is told the field is `""`. */
  it('reports an unrecognised key against the key', () => {
    const details = toErrorDetails([
      { path: [], message: 'Unrecognized key', code: 'unrecognized_keys', keys: ['job_title'] },
    ])

    expect(details).toEqual([{ field: 'job_title', message: 'Unknown field' }])
  })

  it('keeps the path when the unrecognised key is nested', () => {
    const details = toErrorDetails([
      { path: ['profile'], message: 'Unrecognized key', code: 'unrecognized_keys', keys: ['handle'] },
    ])

    expect(details).toEqual([{ field: 'profile.handle', message: 'Unknown field' }])
  })
})

describe('internalErrorBody', () => {
  it('leaks nothing about the cause', () => {
    expect(internalErrorBody()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    })
  })
})

describe('describeThrown', () => {
  it('joins name, code, and message', () => {
    const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })

    expect(describeThrown(error)).toBe('Error: ECONNREFUSED: connection refused')
  })

  it('still says something when the driver leaves the message empty', () => {
    const error = Object.assign(new Error(''), { code: 'CONNECTION_CLOSED' })

    expect(describeThrown(error)).toBe('Error: CONNECTION_CLOSED')
  })

  it('stringifies values that are not errors', () => {
    expect(describeThrown('boom')).toBe('boom')
  })
})
