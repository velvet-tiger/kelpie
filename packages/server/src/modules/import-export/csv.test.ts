import { describe, expect, it } from 'vitest'

import { CsvFormatError, csvLine, parseCsv, serialiseCsv } from './csv.ts'

describe('parseCsv', () => {
  it('reads a header row and keys every row by it', () => {
    const parsed = parseCsv('name,domain\nAcme,acme.com\nHarbour,harbour.io\n')

    expect(parsed.headers).toEqual(['name', 'domain'])
    expect(parsed.rows.map((row) => row.values)).toEqual([
      { name: 'Acme', domain: 'acme.com' },
      { name: 'Harbour', domain: 'harbour.io' },
    ])
  })

  it('numbers rows by their line in the file, counting the header as line 1', () => {
    const parsed = parseCsv('name\nAcme\nHarbour\n')

    expect(parsed.rows.map((row) => row.number)).toEqual([2, 3])
  })

  it('keeps the numbering of rows after a blank line', () => {
    const parsed = parseCsv('name\nAcme\n\nHarbour\n')

    expect(parsed.rows).toHaveLength(2)
    // Harbour is on line 4. The mockup's parser dropped the blank row first and
    // reported this as line 3, pointing an error message at the wrong row.
    expect(parsed.rows.map((row) => row.number)).toEqual([2, 4])
  })

  it('reads a quoted field containing a comma, a newline, and a doubled quote', () => {
    const parsed = parseCsv('name,note\n"Acme, Inc.","Said ""hello""\nthen left"\n')

    expect(parsed.rows[0]?.values).toEqual({
      name: 'Acme, Inc.',
      note: 'Said "hello"\nthen left',
    })
  })

  it('strips a byte-order mark from the first header', () => {
    expect(parseCsv('﻿name\nAcme\n').headers).toEqual(['name'])
  })

  it('reads CRLF line endings', () => {
    const parsed = parseCsv('name,domain\r\nAcme,acme.com\r\n')

    expect(parsed.rows[0]?.values).toEqual({ name: 'Acme', domain: 'acme.com' })
  })

  it('fills a short row with empty cells rather than dropping the columns', () => {
    const parsed = parseCsv('name,domain,hq\nAcme,acme.com\n')

    expect(parsed.rows[0]?.values).toEqual({ name: 'Acme', domain: 'acme.com', hq: '' })
  })

  it('trims cells and headers', () => {
    const parsed = parseCsv(' name , domain \n Acme , acme.com \n')

    expect(parsed.headers).toEqual(['name', 'domain'])
    expect(parsed.rows[0]?.values).toEqual({ name: 'Acme', domain: 'acme.com' })
  })

  it('reads a file with a header and no rows', () => {
    const parsed = parseCsv('name,domain\n')

    expect(parsed.headers).toEqual(['name', 'domain'])
    expect(parsed.rows).toEqual([])
  })

  it('refuses an empty file', () => {
    expect(() => parseCsv('')).toThrow(CsvFormatError)
  })

  it('refuses a header row with an unnamed column', () => {
    expect(() => parseCsv('name,,domain\nAcme,x,acme.com\n')).toThrow(/Column 2/u)
  })

  /**
   * A `column_map` names a header. With two called `Email` there is no answer to
   * which one it meant, and the mockup's parser silently took the last.
   */
  it('refuses a header row that repeats a name', () => {
    expect(() => parseCsv('Email,Name,Email\na,b,c\n')).toThrow(/"Email" appears more than once/u)
  })
})

describe('serialiseCsv', () => {
  it('quotes a cell containing a comma, a quote, or a newline', () => {
    const csv = serialiseCsv(['name', 'note'], [['Acme, Inc.', 'Said "hello"\nthen left']])

    expect(csv).toBe('name,note\n"Acme, Inc.","Said ""hello""\nthen left"\n')
  })

  it('leaves an ordinary cell alone', () => {
    expect(csvLine(['Acme', 'acme.com'])).toBe('Acme,acme.com\n')
  })

  it('round-trips through the parser', () => {
    const rows = [['Acme, Inc.', 'a|b'], ['Harbour "H" Lane', '']]
    const parsed = parseCsv(serialiseCsv(['name', 'tags'], rows))

    expect(parsed.rows.map((row) => [row.values.name, row.values.tags])).toEqual(rows)
  })
})
