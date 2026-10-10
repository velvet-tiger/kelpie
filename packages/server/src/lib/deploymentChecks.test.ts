import { describe, expect, it } from 'vitest'

import { developmentModeWarning, isLoopbackHost, logEmailProviderWarning } from './deploymentChecks.ts'

describe('developmentModeWarning', () => {
  it.each([
    'http://localhost:5173',
    'http://LOCALHOST:5173',
    'http://kelpie.localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.8.8.8',
    'http://[::1]:3000',
  ])('says nothing in development mode on %s', (appBaseUrl) => {
    expect(developmentModeWarning('development', appBaseUrl)).toBeUndefined()
  })

  it.each([
    'https://crm.example.com',
    'http://192.168.1.20:3000',
    'http://10.0.0.5',
    'http://localhost.example.com',
    'http://[2001:db8::1]:3000',
  ])('warns in development mode on %s', (appBaseUrl) => {
    expect(developmentModeWarning('development', appBaseUrl)).toContain('NODE_ENV=production')
  })

  it('says nothing in production or test mode', () => {
    expect(developmentModeWarning('production', 'https://crm.example.com')).toBeUndefined()
    expect(developmentModeWarning('test', 'https://crm.example.com')).toBeUndefined()
  })

  it('says nothing when no base URL is set', () => {
    expect(developmentModeWarning('development', undefined)).toBeUndefined()
  })
})

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', ' localhost ', 'mail.localhost', '127.0.0.1', '127.8.8.8', '::1', '[::1]'])(
    'is true for %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true)
    },
  )

  it.each([
    'smtp.example.com',
    'maildev',
    'localhost.example.com',
    'notlocalhost',
    '10.0.0.5',
    '192.168.1.20',
    '0.0.0.0',
    '2001:db8::1',
    '',
  ])('is false for %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })
})

describe('logEmailProviderWarning', () => {
  it('warns in production that no email is sent, and that the log has no links', () => {
    const warning = logEmailProviderWarning('production', true, false)

    expect(warning).toContain('EMAIL_PROVIDER is "log" in production')
    expect(warning).toContain('no email is sent')
    expect(warning).toContain('EMAIL_LOG_BODY=true')
  })

  it('warns in production that the links are in the log when the body is written', () => {
    const warning = logEmailProviderWarning('production', true, true)

    expect(warning).toContain('no email is sent')
    expect(warning).toContain('Everybody who can read the log can use a link to sign in')
  })

  it.each(['development', 'test'] as const)('says nothing in %s mode', (runtimeMode) => {
    expect(logEmailProviderWarning(runtimeMode, true, true)).toBeUndefined()
    expect(logEmailProviderWarning(runtimeMode, true, false)).toBeUndefined()
  })

  it('says nothing in production for a provider that sends', () => {
    expect(logEmailProviderWarning('production', false, false)).toBeUndefined()
  })
})
