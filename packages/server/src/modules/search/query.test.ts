import { describe, expect, it } from 'vitest'

import { searchWords, snippet, toTsQuery } from './query.ts'

describe('toTsQuery', () => {
  it('makes every word a prefix clause, joined by and', () => {
    expect(toTsQuery('acme renewal')).toBe('acme:* & renewal:*')
  })

  it('matches a partial word, which is what a search box is typed into', () => {
    expect(toTsQuery('acm')).toBe('acm:*')
  })

  it('keeps the words but not the operators, so nothing typed becomes tsquery syntax', () => {
    expect(toTsQuery('acme & renewal | !urgent')).toBe('acme:* & renewal:* & urgent:*')
  })

  it('does not let a quote or a backslash through', () => {
    expect(toTsQuery("o'brien \\ smith")).toBe('o:* & brien:* & smith:*')
  })

  it('survives an input that is nothing but operators', () => {
    expect(toTsQuery('&|!():*')).toBeNull()
  })

  it('treats an email address as its parts', () => {
    expect(toTsQuery('ada@acme.com')).toBe('ada:* & acme:* & com:*')
  })

  it('keeps letters outside ASCII', () => {
    expect(toTsQuery('Öland café')).toBe('Öland:* & café:*')
  })

  it('is null for whitespace only', () => {
    expect(toTsQuery('   ')).toBeNull()
  })
})

describe('searchWords', () => {
  it('splits on the same boundaries the query does', () => {
    expect(searchWords('acme, renewal')).toEqual(['acme', 'renewal'])
  })

  it('is empty when there is nothing to search for', () => {
    expect(searchWords('!!!')).toEqual([])
  })
})

describe('snippet', () => {
  it('centres the fragment on the first word that appears', () => {
    const body = `${'x'.repeat(200)} the renewal conversation ${'y'.repeat(200)}`

    const result = snippet(body, ['renewal'])

    expect(result).toContain('renewal')
    expect(result.startsWith('…')).toBe(true)
    expect(result.endsWith('…')).toBe(true)
  })

  it('centres on the earliest word when several appear', () => {
    const result = snippet('alpha beta gamma', ['gamma', 'beta'])

    expect(result).toBe('alpha beta gamma')
  })

  it('flattens markdown so a page body reads as one line', () => {
    expect(snippet('## Heading\n\n**bold** and `code`', ['heading'])).toBe('Heading bold and code')
  })

  it('falls back to the opening when the match was a stemmed lexeme', () => {
    // The row matched `meeting` for a search of `meetings`; the literal typed
    // word is nowhere in the body.
    const result = snippet('We hold a meeting every Tuesday.', ['meetings'])

    expect(result).toBe('We hold a meeting every Tuesday.')
  })

  it('truncates a long fallback rather than returning the whole body', () => {
    const result = snippet('z'.repeat(500), ['nothing'])

    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBeLessThan(100)
  })

  it('is empty for a record with no prose', () => {
    expect(snippet('', ['acme'])).toBe('')
  })

  it('does not open with an ellipsis when the match is already near the start', () => {
    expect(snippet('Acme renewal', ['acme'])).toBe('Acme renewal')
  })
})
