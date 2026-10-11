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

  /**
   * A row is an object keyed by header, and `__proto__` is the one name an
   * assignment does not store. The cell is lost, and a column map that names
   * the header reads `Object.prototype` where a cell should be.
   */
  describe('a header that is a name every object already has', () => {
    it.each(['__proto__', ' __proto__ ', '"__proto__"'])('refuses the header %j', (header) => {
      const read = (): unknown => parseCsv(`name,${header}\nAcme,x\n`)

      expect(read).toThrow(CsvFormatError)
      expect(read).toThrow(/"__proto__"/u)
    })

    it('refuses it in a file with no rows', () => {
      expect(() => parseCsv('__proto__\n')).toThrow(CsvFormatError)
    })

    it('reads __proto__ in a cell as ordinary data', () => {
      expect(parseCsv('name\n__proto__\n').rows[0]?.values).toEqual({ name: '__proto__' })
    })

    // Each of these is on `Object.prototype` too. An assignment stores them as
    // the row's own property, so they are columns like any other.
    it.each([
      'constructor',
      'toString',
      'toLocaleString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      '__defineGetter__',
      '__lookupSetter__',
      'toJSON',
      'then',
      'prototype',
      '__PROTO__',
      '__proto',
    ])('reads a column headed %s as ordinary data', (header) => {
      const parsed = parseCsv(`${header},name\nfirst,Acme\n,Harbour\n`)
      const values = parsed.rows.map((row) => row.values)

      expect(parsed.headers).toEqual([header, 'name'])
      expect(values.map((row) => Object.entries(row))).toEqual([
        [
          [header, 'first'],
          ['name', 'Acme'],
        ],
        [
          [header, ''],
          ['name', 'Harbour'],
        ],
      ])
      expect(values.map((row) => row[header])).toEqual(['first', ''])
      // A commit stores the row as JSON, so it has to survive that too.
      expect(JSON.parse(JSON.stringify(values))).toEqual([
        { [header]: 'first', name: 'Acme' },
        { [header]: '', name: 'Harbour' },
      ])
    })
  })

  /**
   * The reverse of what `csvLine` writes in front of a formula. The cell is read
   * as the file holds it, so the apostrophe must be its first character.
   */
  describe('a cell an export made safe for a spreadsheet', () => {
    it.each([
      ["'=1+1", '=1+1'],
      ["'+1+1", '+1+1'],
      ["'-cmd", '-cmd'],
      ["'@SUM(A1)", '@SUM(A1)'],
      ["''=1+1", "'=1+1"],
      ["'''=1+1", "''=1+1"],
    ])('reads %j as %j', (cell, value) => {
      expect(parseCsv(`name\n${cell}\n`).rows[0]?.values.name).toBe(value)
    })

    it('removes the apostrophe from a quoted cell too', () => {
      const parsed = parseCsv('name,note\n"\'=A1,B1","\'-said ""hello""\nthen left"\n')

      expect(parsed.rows[0]?.values).toEqual({ name: '=A1,B1', note: '-said "hello"\nthen left' })
    })

    it.each(["'tis the season", "O'Brien", "'", "''", "'quoted'", "' =1+1", 'a\'=1+1'])(
      'leaves the ordinary cell %j alone',
      (cell) => {
        expect(parseCsv(`name\n${cell}\n`).rows[0]?.values.name).toBe(cell)
      },
    )

    it('reads the cell as the file holds it, so white space before the apostrophe keeps it', () => {
      expect(parseCsv("name,note\nAcme, '=1+1\n").rows[0]?.values.note).toBe("'=1+1")
    })

    it('still trims the cell after it removes the apostrophe', () => {
      expect(parseCsv("name\n'=1+1  \n").rows[0]?.values.name).toBe('=1+1')
      expect(parseCsv("name\n'\t=1+1\n").rows[0]?.values.name).toBe('=1+1')
    })

    it('leaves a header alone, because a column map names a header as the file wrote it', () => {
      expect(parseCsv("'=name,domain\nAcme,acme.com\n").headers).toEqual(["'=name", 'domain'])
    })
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

  /**
   * A spreadsheet runs a cell that starts with one of these characters as a
   * formula, and a formula can call a function or start a program. The
   * apostrophe in front makes the cell text.
   */
  describe('a cell a spreadsheet would run as a formula', () => {
    it.each([
      ['=HYPERLINK("https://example.test","x")', '"\'=HYPERLINK(""https://example.test"",""x"")"'],
      ['=1+1', "'=1+1"],
      ['+1+1', "'+1+1"],
      ['-2+3', "'-2+3"],
      ['-cmd', "'-cmd"],
      ['@SUM(A1)', "'@SUM(A1)"],
      ['\t=1+1', "'\t=1+1"],
      ['\r=1+1', '"\'\r=1+1"'],
      ['+61 400 000 000|+61 2 9999 9999', "'+61 400 000 000|+61 2 9999 9999"],
    ])('writes %j as %j', (value, cell) => {
      expect(csvLine([value])).toBe(`${cell}\n`)
    })

    it.each(['+61 400 000 000', '+1 (555) 010-0199', '-12.5', '-1200', '+', '-'])(
      'leaves %j alone, because a sign with no letter after it names nothing',
      (value) => {
        expect(csvLine([value])).toBe(`${value}\n`)
      },
    )

    it('writes a second apostrophe in front of a cell that already starts with one', () => {
      expect(csvLine(["'=1+1"])).toBe("''=1+1\n")
      expect(csvLine(["'+61 400 000 000"])).toBe("''+61 400 000 000\n")
    })

    it('quotes the cell after the apostrophe goes in front', () => {
      expect(csvLine(['=A1,B1', '-said "hello"\nthen left'])).toBe(
        '"\'=A1,B1","\'-said ""hello""\nthen left"\n',
      )
    })

    it.each(["'tis the season", "O'Brien", "'", 'a=b', 'ada@acme.com', '1+1', ' =1+1', '2026-10-11'])(
      'leaves the ordinary cell %j alone',
      (value) => {
        expect(csvLine([value])).toBe(`${value}\n`)
      },
    )

    it('makes every cell of a line safe, the header row included', () => {
      expect(serialiseCsv(['name', '=header'], [['Acme', '@SUM(A1)']])).toBe(
        "name,'=header\nAcme,'@SUM(A1)\n",
      )
    })
  })

  describe('round trip', () => {
    const AWKWARD = [
      '=1+1',
      '+1+1',
      '-2+3',
      '-cmd',
      '@SUM(A1)',
      '=HYPERLINK("https://example.test","x")',
      "=cmd|' /C calc'!A0",
      '=A1,B1',
      '-first line\nsecond line',
      "'=1+1",
      "''=1+1",
      "'-cmd",
      "'+61 400 000 000",
      '+61 400 000 000',
      '+61 400 000 000|+61 2 9999 9999',
      '-12.5',
      '+',
      '-',
      "'tis the season",
      "O'Brien",
      "'",
      "''",
      'Acme, Inc.',
      'Harbour "H" Lane',
      'a|b',
      '',
    ]

    it.each(AWKWARD)('reads %j back as itself', (value) => {
      const parsed = parseCsv(serialiseCsv(['name', 'value'], [['Acme', value]]))

      expect(parsed.rows[0]?.values).toEqual({ name: 'Acme', value })
    })

    it('reads a whole file of them back, each under its own header', () => {
      const headers = AWKWARD.map((_, index) => `c${String(index)}`)
      const parsed = parseCsv(serialiseCsv(headers, [AWKWARD, AWKWARD]))

      expect(parsed.rows.map((row) => headers.map((header) => row.values[header]))).toEqual([
        AWKWARD,
        AWKWARD,
      ])
    })

    /**
     * A cell is trimmed when it is read, as it was before an export wrote the
     * apostrophe. So a value that starts with a tab or a carriage return reads
     * back without it, and the apostrophe does not change that.
     */
    it.each([
      ['\t=1+1', '=1+1'],
      ['\r=1+1', '=1+1'],
      ['\tAcme', 'Acme'],
      ['=1+1  ', '=1+1'],
    ])('reads %j back trimmed, as %j', (value, read) => {
      const parsed = parseCsv(serialiseCsv(['name', 'value'], [['Acme', value]]))

      expect(parsed.rows[0]?.values.value).toBe(read)
    })
  })
})
