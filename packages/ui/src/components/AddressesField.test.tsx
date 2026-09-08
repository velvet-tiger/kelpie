import { PERSON_ADDRESS_KIND_LABELS, PERSON_ADDRESS_KINDS } from '@kelpie/schemas'
import type { PersonAddress } from '@kelpie/schemas'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AddressesField } from './AddressesField.tsx'

afterEach(cleanup)

const home: PersonAddress = {
  kind: 'home',
  line1: '42 Gertrude Street',
  line2: null,
  city: 'Fitzroy',
  region: 'VIC',
  postalCode: '3065',
  country: 'AU',
  primary: true,
}

const work: PersonAddress = {
  kind: 'work',
  line1: '120 Collins Street',
  line2: null,
  city: 'Melbourne',
  region: 'VIC',
  postalCode: '3000',
  country: 'AU',
  primary: false,
}

function renderField(
  value: readonly PersonAddress[],
  onChange = vi.fn(),
): ReturnType<typeof vi.fn> {
  render(
    <AddressesField
      value={value}
      kinds={PERSON_ADDRESS_KINDS}
      kindLabels={PERSON_ADDRESS_KIND_LABELS}
      onChange={onChange}
    />,
  )

  return onChange
}

describe('AddressesField', () => {
  it('shows Primary as a status chip, not as a list action', () => {
    renderField([home, work])

    expect(screen.getByText('Primary')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Primary' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Make Primary' })).toBeNull()
  })

  it('marks one address as primary from the editor and clears the previous mark', () => {
    const onChange = renderField([home, work])

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Make Primary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onChange).toHaveBeenCalledWith([
      { ...home, primary: false },
      { ...work, primary: true },
    ])
  })

  it('does not change primary when the editor is cancelled', () => {
    const onChange = renderField([home, work])

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Make Primary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Make Primary' })).toBeNull()
  })
})
