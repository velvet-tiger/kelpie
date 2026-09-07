import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { stubClient } from '../../testing/stubClient.ts'
import { AuthLayout } from './AuthLayout.tsx'
import { regionHref } from './regionHref.ts'

afterEach(cleanup)

const US = { id: 'us', label: 'United States', origin: 'https://us.kelpie.example' }
const UK = { id: 'uk', label: 'United Kingdom', origin: 'https://uk.kelpie.example' }

function renderLayout(
  regions: readonly { id: string; label: string; origin: string }[],
  step?: 1 | 2 | 3,
): void {
  const client = stubClient({
    get: (path) => {
      if (path === '/public/config') {
        return {
          runtime_mode: 'production',
          site_name: null,
          signups_enabled: true,
          regions,
        }
      }

      throw new Error(`Unexpected GET ${path}`)
    },
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <MemoryRouter>
      <ApiProvider client={client} queryClient={queryClient}>
        {step === undefined ? (
          <AuthLayout title="Sign in">
            <p>form</p>
          </AuthLayout>
        ) : (
          <AuthLayout title="Sign in" step={step}>
            <p>form</p>
          </AuthLayout>
        )}
      </ApiProvider>
    </MemoryRouter>,
  )
}

describe('regionHref', () => {
  it('keeps the path, query, and hash on the other origin', () => {
    expect(
      regionHref('https://uk.kelpie.example', {
        pathname: '/login',
        search: '?next=/join',
        hash: '#top',
      }),
    ).toBe('https://uk.kelpie.example/login?next=/join#top')
  })
})

describe('AuthLayout region switcher', () => {
  it('hides when public config lists no regions', async () => {
    renderLayout([])

    await waitFor(() => {
      expect(screen.getByText('Sign in')).toBeTruthy()
    })

    expect(screen.queryByLabelText('Region')).toBeNull()
  })

  it('hides when public config lists one region', async () => {
    renderLayout([US])

    await waitFor(() => {
      expect(screen.getByText('Sign in')).toBeTruthy()
    })

    expect(screen.queryByLabelText('Region')).toBeNull()
  })

  it('hides on an onboarding step even when two regions exist', async () => {
    renderLayout([US, UK], 1)

    await waitFor(() => {
      expect(screen.getByText('Sign in')).toBeTruthy()
    })

    expect(screen.queryByLabelText('Region')).toBeNull()
  })

  it('shows the current region when this origin is in the list', async () => {
    renderLayout([
      { id: 'here', label: 'Here', origin: window.location.origin },
      UK,
    ])

    const select = (await screen.findByLabelText('Region')) as HTMLSelectElement

    expect(select.value).toBe('here')
  })

  it('navigates to the other origin and keeps the path and query', async () => {
    window.history.replaceState(null, '', '/login?next=/join')
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)

    renderLayout([
      { id: 'here', label: 'Here', origin: window.location.origin },
      UK,
    ])

    const select = (await screen.findByLabelText('Region')) as HTMLSelectElement

    fireEvent.change(select, { target: { value: 'uk' } })

    expect(assign).toHaveBeenCalledWith('https://uk.kelpie.example/login?next=/join')
    assign.mockRestore()
    window.history.replaceState(null, '', '/')
  })
})
