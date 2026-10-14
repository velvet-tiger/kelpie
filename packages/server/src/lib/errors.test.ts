import { createServer } from 'node:net'

import { describe, expect, it } from 'vitest'

import {
  AppError,
  describeCauseForLog,
  describeThrown,
  describeThrownWithCause,
  hasErrorCode,
  internalErrorBody,
  toErrorBody,
  toErrorDetails,
} from './errors.ts'

describe('AppError', () => {
  it('maps each code to its status', () => {
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

describe('describeThrownWithCause', () => {
  function networkError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code })
  }

  it('adds the code of the cause and never its message', () => {
    const error = new TypeError('fetch failed', {
      cause: networkError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:443'),
    })
    const described = describeThrownWithCause(error)

    expect(described).toBe('TypeError: fetch failed (ECONNREFUSED)')
    expect(described).not.toContain('10.0.0.5')
  })

  it('reads the codes of every address a connection tried', () => {
    const cause = new AggregateError([
      networkError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:443'),
      networkError('ETIMEDOUT', 'connect ETIMEDOUT [fd00::5]:443'),
      networkError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.6:443'),
    ])

    expect(describeThrownWithCause(new TypeError('fetch failed', { cause }))).toBe(
      'TypeError: fetch failed (ECONNREFUSED, ETIMEDOUT)',
    )
  })

  it('leaves out a code that is not shaped like one', () => {
    const error = new TypeError('fetch failed', { cause: networkError('10.0.0.5', 'x') })

    expect(describeThrownWithCause(error)).toBe('TypeError: fetch failed')
  })

  it('is describeThrown when there is no cause', () => {
    expect(describeThrownWithCause(new Error('boom'))).toBe('Error: boom')
    expect(describeThrownWithCause('boom')).toBe('boom')
  })
})

/**
 * Real `fetch` failures, no stub: the shape of `cause` is what the helpers
 * read, and a stub can only repeat what the author believed it to be.
 */
describe('describeThrownWithCause against a real fetch', () => {
  /** A port that refuses: a server took it, then closed. */
  async function closedPort(): Promise<number> {
    const server = createServer()

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })

    const address = server.address()

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })

    if (address === null || typeof address === 'string') {
      throw new Error('The test server had no port')
    }

    return address.port
  }

  async function failureOf(url: string): Promise<unknown> {
    try {
      await fetch(url)
    } catch (error: unknown) {
      return error
    }

    throw new Error(`${url} answered`)
  }

  it('names a refused connection by its code, and keeps the address for the log', async () => {
    const error = await failureOf(`http://127.0.0.1:${String(await closedPort())}/`)

    expect(describeThrownWithCause(error)).toBe('TypeError: fetch failed (ECONNREFUSED)')
    expect(describeCauseForLog(error)).toContain('127.0.0.1')
  })

  it('names a port that fetch refuses to use', async () => {
    const error = await failureOf('http://127.0.0.1:1/')

    expect(describeThrownWithCause(error)).toBe('TypeError: fetch failed (bad port)')
  })
})

describe('describeCauseForLog', () => {
  it('gives every member of an AggregateError cause, messages included', () => {
    const cause = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED [fd00::5]:443'), { code: 'ECONNREFUSED' }),
    ])
    const described = describeCauseForLog(new TypeError('fetch failed', { cause }))

    expect(described).toContain('10.0.0.5')
    expect(described).toContain('fd00::5')
  })

  it('is undefined with no cause', () => {
    expect(describeCauseForLog(new Error('boom'))).toBeUndefined()
    expect(describeCauseForLog('boom')).toBeUndefined()
  })
})

describe('hasErrorCode', () => {
  const dns = Object.assign(new Error('getaddrinfo EAI_AGAIN example.com'), { code: 'EAI_AGAIN' })

  it('finds the code on the error, its cause, and the members of an AggregateError cause', () => {
    expect(hasErrorCode(dns, 'EAI_AGAIN')).toBe(true)
    expect(hasErrorCode(new TypeError('fetch failed', { cause: dns }), 'EAI_AGAIN')).toBe(true)
    expect(hasErrorCode(new TypeError('fetch failed', { cause: new AggregateError([dns]) }), 'EAI_AGAIN')).toBe(true)
  })

  it('is false for another code and for a value that is not an error', () => {
    expect(hasErrorCode(dns, 'ENOTFOUND')).toBe(false)
    expect(hasErrorCode('EAI_AGAIN', 'EAI_AGAIN')).toBe(false)
  })
})
