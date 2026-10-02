import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import type { QueryParameters } from '../api/client.ts'
import { stubClient } from '../testing/stubClient.ts'
import { TagInput } from './TagInput.tsx'

afterEach(cleanup)

/** Every tag a person carries in this workspace, as `GET /v1/tags` would rank them. */
const IN_USE = [
  { tag: 'waitlist', count: 4 },
  { tag: 'investor', count: 2 },
  { tag: 'advisor', count: 1 },
]

function Harness({ initial = [] }: { readonly initial?: readonly string[] }): JSX.Element {
  const [tags, setTags] = useState<readonly string[]>(initial)

  return <TagInput value={tags} onChange={setTags} targetType="person" />
}

function renderHarness(initial: readonly string[] = []): { readonly calls: QueryParameters[] } {
  const calls: QueryParameters[] = []
  const client = stubClient({
    get: (path, query) => {
      if (path !== '/tags') {
        throw new Error(`Unexpected get ${path}`)
      }

      calls.push(query ?? {})
      const term = typeof query?.q === 'string' ? query.q.toLowerCase() : ''

      return {
        query: term.length === 0 ? null : term,
        limit: 20,
        tags: IN_USE.filter((row) => row.tag.includes(term)),
      }
    },
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <ApiProvider client={client} queryClient={queryClient}>
      <Harness initial={initial} />
    </ApiProvider>,
  )

  return { calls }
}

function chips(): readonly string[] {
  return screen
    .queryAllByRole('button', { name: /^Remove tag / })
    .map((button) => (button.getAttribute('aria-label') ?? '').replace('Remove tag ', ''))
}

describe('TagInput', () => {
  it('lists chosen tags below an empty search box', () => {
    renderHarness(['waitlist', 'foo'])

    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('')
    expect(chips()).toEqual(['waitlist', 'foo'])
  })

  it('suggests the tags in use for its type on focus, chosen ones first and ticked', async () => {
    const { calls } = renderHarness(['waitlist'])

    fireEvent.focus(screen.getByRole('combobox'))
    await screen.findByRole('button', { name: /investor/ })

    const options = screen.getAllByRole('option')

    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ])
    expect(options[0]?.textContent).toContain('waitlist')
    expect(options[0]?.textContent).toContain('Added')
    expect(calls[0]?.target_type).toBe('person')
  })

  it('starts the highlight on the first tag not chosen, so Enter adds it', async () => {
    renderHarness(['waitlist'])
    const input = screen.getByRole('combobox')

    fireEvent.focus(input)
    await screen.findByRole('button', { name: /investor/ })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(chips()).toEqual(['waitlist', 'investor'])
  })

  it('does not remove a chosen tag on Enter when nothing else is offered', async () => {
    renderHarness(['waitlist', 'investor', 'advisor'])
    const input = screen.getByRole('combobox')

    fireEvent.focus(input)
    await screen.findByRole('button', { name: /^advisor\s*Added/ })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(chips()).toEqual(['waitlist', 'investor', 'advisor'])
  })

  it('removes a chosen tag clicked in the list', async () => {
    renderHarness(['waitlist', 'foo'])

    fireEvent.focus(screen.getByRole('combobox'))
    await screen.findByRole('button', { name: /investor/ })
    fireEvent.click(screen.getByRole('button', { name: /^foo\s*Added/ }))

    expect(chips()).toEqual(['waitlist'])
  })

  it('keeps the chips in view while the list is open', async () => {
    renderHarness(['waitlist'])

    fireEvent.focus(screen.getByRole('combobox'))
    await screen.findByRole('button', { name: /investor/ })

    expect(screen.getByRole('listbox').className).not.toContain('absolute')
    expect(chips()).toEqual(['waitlist'])
  })

  it('adds a picked suggestion and clears the box', async () => {
    renderHarness()
    const input = screen.getByRole('combobox') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'inv' } })
    fireEvent.click(await screen.findByRole('button', { name: /investor/ }))

    expect(chips()).toEqual(['investor'])
    expect(input.value).toBe('')
  })

  it('creates a tag nobody uses yet', async () => {
    renderHarness()
    const input = screen.getByRole('combobox')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'conference' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Create “conference”' }))

    expect(chips()).toEqual(['conference'])
  })

  it('takes the existing spelling when the case differs', async () => {
    renderHarness()
    const input = screen.getByRole('combobox')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Investor' } })
    await screen.findByRole('button', { name: /investor/ })

    expect(screen.queryByRole('button', { name: /^Create/ })).toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(chips()).toEqual(['investor'])
  })

  it('ends a typed tag on a comma', () => {
    renderHarness()
    const input = screen.getByRole('combobox') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'foo,' } })

    expect(chips()).toEqual(['foo'])
    expect(input.value).toBe('')
  })

  it('adds every tag in a pasted list and keeps the unfinished one', () => {
    renderHarness(['foo'])
    const input = screen.getByRole('combobox') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'a, foo, b,c' } })

    expect(chips()).toEqual(['foo', 'a', 'b'])
    expect(input.value).toBe('c')
  })

  it('removes a tag with its × button', () => {
    renderHarness(['waitlist', 'foo'])

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag waitlist' }))

    expect(chips()).toEqual(['foo'])
  })
})
