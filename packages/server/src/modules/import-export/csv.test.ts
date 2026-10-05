import { MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS } from '@kelpie/schemas'
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

  describe('limits', () => {
    const limits = { maxRows: 3, maxColumns: 4 }

    it('reads a file that is exactly at both limits', () => {
      const parsed = parseCsv('a,b,c,d\n1,2,3,4\n1,2,3,4\n1,2,3,4\n', limits)

      expect(parsed.headers).toHaveLength(4)
      expect(parsed.rows).toHaveLength(3)
    })

    it('refuses a header row with too many columns', () => {
      expect(() => parseCsv('a,b,c,d,e\n1,2,3,4,5\n', limits)).toThrow(/at most 4 columns/u)
    })

    it('refuses a file with too many rows', () => {
      expect(() => parseCsv('a\n1\n2\n3\n4\n', limits)).toThrow(/at most 3 rows/u)
    })

    it('does not count blank rows, and keeps the line numbers of the rows after them', () => {
      const parsed = parseCsv('a\n1\n\n\n2\n\n3\n', limits)

      expect(parsed.rows.map((row) => row.number)).toEqual([2, 5, 7])
    })

    it('ignores the cells of a data row past the last header', () => {
      const parsed = parseCsv(`a,b\n1,2${',x'.repeat(50)}\n`, limits)

      expect(parsed.rows[0]?.values).toEqual({ a: '1', b: '2' })
    })

    it('uses the import limits by default', () => {
      const wide = Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, index) => `c${String(index)}`)
      const long = `a\n${'1\n'.repeat(MAX_IMPORT_ROWS + 1)}`

      expect(() => parseCsv(`${wide.join(',')}\n`)).toThrow(/at most 500 columns/u)
      expect(() => parseCsv(long)).toThrow(/at most 10000 rows/u)
    })

    it('reads ten megabytes of commas or of line breaks without holding them', () => {
      const size = 10 * 1024 * 1024
      const started = performance.now()

      expect(() => parseCsv(','.repeat(size))).toThrow(CsvFormatError)
      expect(() => parseCsv(`a\n${'\n'.repeat(size)}`)).not.toThrow()
      expect(performance.now() - started).toBeLessThan(5000)
    })
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
