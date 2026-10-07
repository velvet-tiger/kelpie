import { describe, expect, it } from 'vitest'

import { developmentModeWarning } from './deploymentChecks.ts'

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
