import { SOCIAL_NETWORK_IDS, SOCIAL_NETWORK_LABELS } from '@kelpie/schemas'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SocialNetworkIcon, SocialNetworkName } from './SocialNetworkIcon.tsx'

afterEach(cleanup)

describe('SocialNetworkIcon', () => {
  it('renders an svg for every social network id', () => {
    for (const network of SOCIAL_NETWORK_IDS) {
      const { container } = render(<SocialNetworkIcon network={network} />)

      expect(container.querySelector('svg')).not.toBeNull()
      cleanup()
    }
  })
})

describe('SocialNetworkName', () => {
  it('shows the display name next to the mark', () => {
    render(<SocialNetworkName network="linkedin" />)

    expect(screen.getByText(SOCIAL_NETWORK_LABELS.linkedin)).toBeTruthy()
    expect(document.querySelector('svg')).not.toBeNull()
  })
})
