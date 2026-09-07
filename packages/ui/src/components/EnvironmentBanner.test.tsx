import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import { stubClient } from '../testing/stubClient.ts'
import { EnvironmentBanner } from './EnvironmentBanner.tsx'
import { environmentTone } from './environmentTone.ts'

afterEach(cleanup)

function renderWith(wire: { runtime_mode: string; site_name: string | null; signups_enabled: boolean }): void {
  const client = stubClient({
    get: (path) => {
      if (path === '/public/config') {
        return wire
      }

      throw new Error(`Unexpected GET ${path}`)
    },
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <ApiProvider client={client} queryClient={queryClient}>
      <EnvironmentBanner />
    </ApiProvider>,
  )
}

describe('environmentTone', () => {
  it('gives each known name a stable colour', () => {
    expect(environmentTone('dev')).toBe('dev')
    expect(environmentTone('development')).toBe('dev')
    expect(environmentTone('local')).toBe('dev')
    expect(environmentTone('demo')).toBe('demo')
    expect(environmentTone('staging')).toBe('staging')
    expect(environmentTone('stage')).toBe('staging')
    expect(environmentTone('preview')).toBe('staging')
    expect(environmentTone('test')).toBe('test')
    expect(environmentTone('cloud')).toBe('cloud')
  })

  it('ignores case and surrounding space', () => {
    expect(environmentTone('  DEV  ')).toBe('dev')
    expect(environmentTone('Demo')).toBe('demo')
  })

  it('hashes an unknown name onto the same five colours', () => {
    expect(['dev', 'demo', 'staging', 'test', 'cloud']).toContain(environmentTone('sandbox'))
  })
})

describe('EnvironmentBanner', () => {
  it('names the site when the mode is not production', async () => {
    renderWith({ runtime_mode: 'development', site_name: 'dev', signups_enabled: true })

    const strip = await screen.findByText('dev')
    expect(strip.textContent).toBe('dev')
    expect(strip.getAttribute('data-tone')).toBe('dev')
  })

  it('paints the demo site in a different colour from local', async () => {
    renderWith({ runtime_mode: 'development', site_name: 'demo', signups_enabled: true })

    expect((await screen.findByText('demo')).getAttribute('data-tone')).toBe('demo')
  })

  it('paints the cloud site in a different colour from demo', async () => {
    renderWith({ runtime_mode: 'development', site_name: 'cloud', signups_enabled: true })

    expect((await screen.findByText('cloud')).getAttribute('data-tone')).toBe('cloud')
  })

  it('falls back to the runtime mode when no site name is set', async () => {
    renderWith({ runtime_mode: 'development', site_name: null, signups_enabled: true })

    const strip = await screen.findByText('development')
    expect(strip.textContent).toBe('development')
    expect(strip.getAttribute('data-tone')).toBe('dev')
  })

  it('renders nothing on production', async () => {
    renderWith({ runtime_mode: 'production', site_name: 'kelpie-cloud', signups_enabled: true })

    // A tick for React Query to settle, then confirm no strip is on screen.
    await waitFor(() => {
      expect(screen.queryByText('kelpie-cloud')).toBeNull()
      expect(screen.queryByText('production')).toBeNull()
    })
  })
})
