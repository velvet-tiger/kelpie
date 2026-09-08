import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InlineEdit } from './InlineEdit.tsx'

afterEach(cleanup)

describe('InlineEdit', () => {
  it('opens an editor when the empty label is clicked', () => {
    render(<InlineEdit value="" onChange={vi.fn()} emptyLabel="Add domain…" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add domain…' }))

    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
  })

  it('shows Visit and Edit when a visitable value is set', () => {
    render(<InlineEdit value="sandbox.example" onChange={vi.fn()} visitable />)

    const visit = screen.getByRole('link', { name: 'Visit' })

    expect(visit.getAttribute('href')).toBe('https://sandbox.example')
    expect(visit.getAttribute('target')).toBe('_blank')
    expect(visit.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByRole('button', { name: 'Edit' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'sandbox.example' })).toBeNull()
  })

  it('keeps an existing http(s) scheme on Visit', () => {
    render(<InlineEdit value="https://northwind.dev" onChange={vi.fn()} visitable />)

    expect(screen.getByRole('link', { name: 'Visit' }).getAttribute('href')).toBe(
      'https://northwind.dev',
    )
  })

  it('makes the value editable from Edit', () => {
    render(<InlineEdit value="sandbox.example" onChange={vi.fn()} visitable />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('sandbox.example')
    expect(screen.queryByRole('link', { name: 'Visit' })).toBeNull()
  })

  it('does not show Visit when a visitable value is empty', () => {
    render(<InlineEdit value="" onChange={vi.fn()} visitable emptyLabel="Add domain…" />)

    expect(screen.queryByRole('link', { name: 'Visit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add domain…' })).not.toBeNull()
  })
})
