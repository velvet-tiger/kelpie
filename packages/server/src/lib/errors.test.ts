import { describe, expect, it } from 'vitest'

import { AppError, describeThrown, internalErrorBody, toErrorBody } from './errors.ts'

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
