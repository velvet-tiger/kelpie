import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { TimezoneSearch } from './TimezoneSearch.tsx'

afterEach(cleanup)

function Harness({
  initial = '',
  required,
}: {
  readonly initial?: string
  readonly required?: boolean
}): JSX.Element {
  const [timezone, setTimezone] = useState(initial)

  return <TimezoneSearch value={timezone} onChange={setTimezone} required={required} />
}

describe('TimezoneSearch', () => {
  it('offers a searchable IANA list when nothing is stored', () => {
    render(<Harness />)

    const input = screen.getByRole('combobox')

    expect(input.getAttribute('placeholder')).toBe('Search time zones…')

    fireEvent.focus(input)

    expect(screen.getByRole('option', { name: 'UTC' })).toBeTruthy()
    expect(screen.getByText('Showing top 20 — keep typing to narrow')).toBeTruthy()
  })

  it('filters the list to matching zone names', () => {
    render(<Harness />)

    const input = screen.getByRole('combobox')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Sydney' } })

    expect(screen.getByRole('option', { name: 'Australia/Sydney' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'UTC' })).toBeNull()
  })

  it('commits a picked zone', () => {
    render(<Harness />)

    const input = screen.getByRole('combobox')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Sydney' } })
    fireEvent.click(screen.getByRole('button', { name: 'Australia/Sydney' }))

    expect(screen.getByText('Australia/Sydney')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('clears an optional zone back to the search field', () => {
    render(<Harness initial="UTC" />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(screen.getByRole('combobox').getAttribute('placeholder')).toBe('Search time zones…')
  })

  it('keeps a required zone when the clear control is used', () => {
    render(<Harness initial="UTC" required />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByRole('combobox')).toBeTruthy()

    fireEvent.mouseDown(document.body)

    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText('UTC')).toBeTruthy()
  })

  it('renders a stored zone without a combobox when disabled', () => {
    render(<TimezoneSearch value="Europe/London" onChange={() => undefined} disabled />)

    expect(screen.getByText('Europe/London')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
