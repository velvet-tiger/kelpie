import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { KanbanBoard } from './KanbanBoard.tsx'
import type { KanbanCard, KanbanStage } from './KanbanBoard.tsx'

const STAGES: readonly KanbanStage[] = [
  { id: 'qualifying', label: 'Qualifying' },
  { id: 'proposal', label: 'Proposal' },
]

const CARDS: readonly KanbanCard[] = [
  { id: 'deal_1', stage: 'qualifying', title: 'Initech — pilot', href: '/deals/deal_1' },
  { id: 'deal_2', stage: 'proposal', title: 'Northwind', href: '/deals/deal_2' },
]

function stubViewport(narrow: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: narrow,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  )
}

function renderBoard(onMove = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <MemoryRouter>
      <KanbanBoard stages={STAGES} cards={CARDS} onMove={onMove} />
    </MemoryRouter>,
  )

  return onMove
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('KanbanBoard below md', () => {
  it('lists each card with a link and a stage menu', () => {
    stubViewport(true)
    renderBoard()

    expect(screen.getByRole('link', { name: /Initech — pilot/u }).getAttribute('href')).toBe(
      '/deals/deal_1',
    )
    const menu = screen.getByRole('combobox', { name: 'Stage for Northwind' }) as HTMLSelectElement
    expect(menu.value).toBe('proposal')
  })

  it('moves a card when its stage menu changes', () => {
    stubViewport(true)
    const onMove = renderBoard()

    fireEvent.change(screen.getByRole('combobox', { name: 'Stage for Initech — pilot' }), {
      target: { value: 'proposal' },
    })

    expect(onMove).toHaveBeenCalledWith('deal_1', 'proposal')
  })

  it('collapses and reopens a stage from its header', () => {
    stubViewport(true)
    renderBoard()

    const header = screen.getByRole('button', { name: /Qualifying/u })
    expect(header.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(header)

    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('link', { name: /Initech — pilot/u })).toBeNull()
    expect(screen.getByRole('link', { name: /Northwind/u })).toBeTruthy()

    fireEvent.click(header)

    expect(screen.getByRole('link', { name: /Initech — pilot/u })).toBeTruthy()
  })
})

describe('KanbanBoard from md up', () => {
  it('renders the drag board with no stage menus', () => {
    stubViewport(false)
    renderBoard()

    expect(screen.getByText('Initech — pilot')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
