import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarkdownView } from './MarkdownView.tsx'

/**
 * The markdown renderer adopted in roadmap decision 5.
 *
 * Two things are worth asserting. The first is that the syntax the decision
 * listed as the requirement actually renders, since the hand-rolled renderer it
 * replaced covered exactly that list. The second is that raw HTML does not: a
 * handbook page is written by one workspace member and read by all of them, and
 * an agent with write access is another author again.
 */

describe('MarkdownView', () => {
  it('renders the syntax the decision required', () => {
    render(
      <MarkdownView
        source={[
          '# Title',
          '',
          '## Section',
          '',
          '### Detail',
          '',
          'Some **bold** text with `code` and a [link](https://example.com).',
          '',
          '- first',
          '- second',
          '',
          '1. one',
          '2. two',
          '',
          '| Plan | Price |',
          '| --- | --- |',
          '| Team | $20 |',
        ].join('\n')}
      />,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeDefined()
    expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toBeDefined()
    expect(screen.getByRole('heading', { level: 3, name: 'Detail' })).toBeDefined()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('code').tagName).toBe('CODE')
    expect(screen.getByRole('link', { name: 'link' }).getAttribute('href')).toBe(
      'https://example.com',
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByRole('table')).toBeDefined()
    expect(screen.getByRole('cell', { name: '$20' })).toBeDefined()
  })

  it('escapes raw HTML in a page body instead of rendering it', () => {
    const { container } = render(
      <MarkdownView source={'<img src=x onerror="alert(1)">\n\n<b>not bold</b>'} />,
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<b>not bold</b>')
  })

  it('escapes a script tag rather than mounting it', () => {
    const { container } = render(<MarkdownView source={'<script>alert(1)</script>'} />)

    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })
})
