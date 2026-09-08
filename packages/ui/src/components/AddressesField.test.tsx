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

describe('AddressesField', () => {
  it('marks one address as primary and clears the previous mark', () => {
    const onChange = vi.fn()

    render(
      <AddressesField
        value={[home, work]}
        kinds={PERSON_ADDRESS_KINDS}
        kindLabels={PERSON_ADDRESS_KIND_LABELS}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Primary' }))

    expect(onChange).toHaveBeenCalledWith([
      { ...home, primary: false },
      { ...work, primary: true },
    ])
  })
})
