import type { SocialProfile } from '@kelpie/schemas'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SocialProfileIcons, SocialProfilesField } from './SocialProfilesField.tsx'

afterEach(cleanup)

const linkedin: SocialProfile = {
  network: 'linkedin',
  url: 'https://linkedin.com/in/ada',
}

describe('SocialProfileIcons', () => {
  it('renders an outbound icon link for each profile', () => {
    render(<SocialProfileIcons profiles={[linkedin]} />)

    const link = screen.getByRole('link', { name: 'LinkedIn' })

    expect(link.getAttribute('href')).toBe('https://linkedin.com/in/ada')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.querySelector('svg')).not.toBeNull()
  })

  it('renders nothing when there are no profiles', () => {
    const { container } = render(<SocialProfileIcons profiles={[]} />)

    expect(container.querySelector('a')).toBeNull()
  })
})

describe('SocialProfilesField', () => {
  it('shows a brand mark on each saved profile', () => {
    render(<SocialProfilesField value={[linkedin]} onChange={() => undefined} />)

    const link = screen.getByRole('link', { name: 'LinkedIn · in/ada' })

    expect(link.querySelector('svg')).not.toBeNull()
  })

  it('shows brand marks in the network picker', () => {
    render(<SocialProfilesField value={[]} onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '+ Add' }))

    const github = screen.getByRole('option', { name: 'GitHub' })

    expect(github.querySelector('svg')).not.toBeNull()
  })
})
