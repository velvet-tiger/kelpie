import { act, cleanup, render, screen } from '@testing-library/react'
import { Link, MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { useRecordTab } from './fragmentTarget.ts'

afterEach(() => {
  cleanup()
})

function Page(): React.JSX.Element {
  const [tab, setTab] = useRecordTab()

  return (
    <>
      <p>tab:{tab}</p>
      <button
        type="button"
        onClick={() => {
          setTab('activity')
        }}
      >
        Activity
      </button>
      <Link to="#dec_1">to decision</Link>
    </>
  )
}

function renderAt(entry: string): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Page />
    </MemoryRouter>,
  )
}

describe('useRecordTab', () => {
  it('starts on Overview with no fragment', () => {
    renderAt('/companies/com_1')

    expect(screen.getByText('tab:overview')).not.toBeNull()
  })

  it('opens the tab a note, decision or plan item fragment points into', () => {
    renderAt('/companies/com_1#note_1')
    expect(screen.getByText('tab:notes')).not.toBeNull()
    cleanup()

    renderAt('/deals/deal_1#plan_1')
    expect(screen.getByText('tab:plan')).not.toBeNull()
  })

  it('ignores a fragment it does not know', () => {
    renderAt('/companies/com_1#top')

    expect(screen.getByText('tab:overview')).not.toBeNull()
  })

  it('switches when the fragment changes on the same page, and a click still wins', async () => {
    renderAt('/companies/com_1')

    await act(async () => {
      screen.getByRole('button', { name: 'Activity' }).click()
    })
    expect(screen.getByText('tab:activity')).not.toBeNull()

    await act(async () => {
      screen.getByRole('link', { name: 'to decision' }).click()
    })
    expect(screen.getByText('tab:decisions')).not.toBeNull()
  })
})
