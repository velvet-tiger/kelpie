import type { RecordReference } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { splitOnReferences } from './recordReferences.ts'

const partnership: RecordReference = {
  targetType: 'partnership',
  targetId: 'prt_01M1DDZFG3N7TWB3F3X4AV4S96',
  name: 'Sandbox alumni',
  parent: null,
}

describe('splitOnReferences', () => {
  it('keeps the text whole when nothing is cited', () => {
    expect(splitOnReferences('No ids here', [])).toEqual([{ kind: 'text', text: 'No ids here' }])
  })

  it('cuts the text around each cited id, including at either end', () => {
    const id = partnership.targetId

    expect(splitOnReferences(`${id} and again ${id}`, [partnership])).toEqual([
      { kind: 'reference', reference: partnership },
      { kind: 'text', text: ' and again ' },
      { kind: 'reference', reference: partnership },
    ])
  })

  it('leaves an id the server did not name as plain text', () => {
    const text = 'See prt_01M1DDZFG3N7TWB3F3X4AV4S00'

    expect(splitOnReferences(text, [partnership])).toEqual([{ kind: 'text', text }])
  })

  it('reads a [[type:id|Label]] token as the record, named by the server', () => {
    const id = partnership.targetId

    expect(splitOnReferences(`Via [[partnership:${id}|Old name]].`, [partnership])).toEqual([
      { kind: 'text', text: 'Via ' },
      { kind: 'reference', reference: partnership },
      { kind: 'text', text: '.' },
    ])
  })

  it('matches the id inside a token once, not again as a bare id', () => {
    const id = partnership.targetId

    expect(
      splitOnReferences(`[[partnership:${id}|X]] ${id}`, [partnership]).filter(
        (segment) => segment.kind === 'reference',
      ),
    ).toHaveLength(2)
  })

  it('shows the label of a token the server did not name', () => {
    const token = { targetType: 'company', targetId: 'com_gone', label: 'Acme' } as const

    expect(splitOnReferences('See [[company:com_gone|Acme]]', [])).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'unresolved', token },
    ])
  })
})
