import { OBJECT_COLUMNS, findMatchKey } from '@kelpie/schemas'
import type {
  ImportConflictMode,
  ImportObject,
  MatchKeyOption,
  OnMissingCompany,
} from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { baseColumnKeySet } from './customFieldImport.ts'
import { countPlans, planRow, planRows } from './plan.ts'
import type { ImportLookups, MappedRow, PlanContext } from './plan.ts'

/**
 * The dry-run planner, over maps rather than a database.
 *
 * These are the rules a preview screen shows and a commit then carries out, so
 * they are worth pinning without a Postgres round trip: what counts as a match,
 * what the conflict mode does with one, and which unresolved reference fails a
 * row rather than being quietly filled in.
 */

const NO_LOOKUPS: ImportLookups = {
  existing: new Map(),
  personIdByEmail: new Map(),
  companyIdByDomain: new Map(),
  companyIdByName: new Map(),
  memberIdByEmail: new Map(),
  stageIdByName: new Map(),
}

function keyFor(object: ImportObject, id: string): MatchKeyOption {
  const key = findMatchKey(object, id)

  if (key === undefined) {
    throw new Error(`No match key ${id} for ${object}`)
  }

  return key
}

function contextFor(
  object: ImportObject,
  options: {
    matchKeyId?: string
    conflictMode?: ImportConflictMode
    onMissingCompany?: OnMissingCompany
    lookups?: Partial<ImportLookups>
  } = {},
): PlanContext {
  return {
    object,
    matchKey: keyFor(object, options.matchKeyId ?? defaultKey(object)),
    conflictMode: options.conflictMode ?? 'skip',
    onMissingCompany: options.onMissingCompany ?? 'skip',
    consentPurposeId: null,
    lookups: { ...NO_LOOKUPS, ...options.lookups },
    customFieldDefinitions: [],
    baseColumnKeys: baseColumnKeySet(OBJECT_COLUMNS[object]),
  }
}

function defaultKey(object: ImportObject): string {
  return {
    companies: 'domain',
    people: 'email',
    positions: 'person_email|company_domain|title',
    deals: 'external_id',
    opportunities: 'name|company_domain',
    enquiries: 'name|company_domain',
    partnerships: 'name|company_domain',
    raises: 'name|company_domain',
    custom_fields: 'object_type|key',
  }[object]
}

describe('planRow', () => {
  it('creates a row whose key matches nothing', () => {
    const plan = planRow(contextFor('companies'), { name: 'Acme', domain: 'acme.com' })

    expect(plan.action).toBe('create')
  })

  it('reports every problem with a row at once', () => {
    const plan = planRow(contextFor('people'), {
      name: 'Ada',
      email: 'ada@acme.com',
      influence: 'sponsor',
      relationship: 'lukewarm',
    })

    expect(plan.action).toBe('error')
    expect(plan.action === 'error' && plan.errors.map((error) => error.field)).toEqual([
      'influence',
      'relationship',
    ])
  })

  it('reports a missing required cell instead of the shape problems behind it', () => {
    const plan = planRow(contextFor('people'), { name: 'Ada', email: '' })

    expect(plan.action === 'error' && plan.errors).toEqual([
      { field: 'email', message: 'Missing required field' },
    ])
  })

  it('accepts an enum written with a capital, and stores the canonical form', () => {
    const plan = planRow(contextFor('companies'), {
      name: 'Acme',
      domain: 'acme.com',
      account_type: 'Prospect',
    })

    expect(plan.action).toBe('create')
    expect(plan.action === 'create' && plan.write.object === 'companies' && plan.write.draft.accountType).toBe(
      'prospect',
    )
  })

  it('refuses an enum value nothing recognises rather than coercing it', () => {
    const plan = planRow(contextFor('companies'), {
      name: 'Acme',
      domain: 'acme.com',
      account_type: 'Client',
    })

    expect(plan.action === 'error' && plan.errors[0]?.field).toBe('account_type')
  })

  describe('when the key matches a stored record', () => {
    const existing = new Map([['domain:acme.com', 'com_1']])

    it('skips it in skip mode', () => {
      const plan = planRow(contextFor('companies', { lookups: { existing } }), {
        name: 'Acme',
        domain: 'acme.com',
      })

      expect(plan).toMatchObject({ action: 'skip', targetId: 'com_1' })
    })

    it('updates it in update mode', () => {
      const plan = planRow(
        contextFor('companies', { conflictMode: 'update', lookups: { existing } }),
        { name: 'Acme Corp', domain: 'acme.com' },
      )

      expect(plan).toMatchObject({ action: 'update', targetId: 'com_1' })
    })

    it('matches past a scheme and a path in the file', () => {
      const plan = planRow(contextFor('companies', { lookups: { existing } }), {
        name: 'Acme',
        domain: 'https://ACME.com/about',
      })

      expect(plan.action).toBe('skip')
    })
  })

  describe('positions', () => {
    const lookups = {
      personIdByEmail: new Map([['ada@acme.com', 'per_1']]),
      companyIdByDomain: new Map([['acme.com', 'com_1']]),
    }

    it('resolves both ends', () => {
      const plan = planRow(contextFor('positions', { lookups }), {
        person_email: 'ada@acme.com',
        company_domain: 'acme.com',
        title: 'CTO',
      })

      expect(plan).toMatchObject({
        action: 'create',
        write: { object: 'positions', personId: 'per_1', companyId: 'com_1', title: 'CTO' },
      })
    })

    it('fails the row when the person is not here yet, naming the order to import in', () => {
      const plan = planRow(contextFor('positions', { lookups }), {
        person_email: 'grace@acme.com',
        company_domain: 'acme.com',
        title: 'CTO',
      })

      expect(plan.action === 'error' && plan.errors[0]).toMatchObject({
        field: 'person_email',
        message: expect.stringContaining('Import people first') as unknown as string,
      })
    })

    it('reports both ends missing at once', () => {
      const plan = planRow(contextFor('positions'), {
        person_email: 'grace@acme.com',
        company_domain: 'harbour.io',
        title: 'CTO',
      })

      expect(plan.action === 'error' && plan.errors.map((error) => error.field)).toEqual([
        'person_email',
        'company_domain',
      ])
    })
  })

  describe('people affiliation', () => {
    const lookups = {
      companyIdByDomain: new Map([['acme.com', 'com_1']]),
      companyIdByName: new Map([['acme', 'com_1']]),
    }

    const person = { name: 'Grace', email: 'grace@acme.com' }

    it('carries no affiliation when the row names no company or title', () => {
      const plan = planRow(contextFor('people'), person)

      expect(plan).toMatchObject({ action: 'create', write: { object: 'people' } })
      expect(plan.action === 'create' && 'affiliation' in plan.write).toBe(false)
    })

    it('links a known company by domain', () => {
      const plan = planRow(contextFor('people', { lookups }), {
        ...person,
        company_domain: 'acme.com',
        title: 'Engineer',
      })

      expect(plan).toMatchObject({
        action: 'create',
        write: { object: 'people', affiliation: { kind: 'link', companyId: 'com_1', title: 'Engineer' } },
      })
    })

    it('matches by name when the row carries no domain', () => {
      const plan = planRow(contextFor('people', { lookups }), {
        ...person,
        company_name: 'Acme',
        title: 'Engineer',
      })

      expect(plan).toMatchObject({
        write: { affiliation: { kind: 'link', companyId: 'com_1' } },
      })
    })

    it('carries no affiliation when the title is blank', () => {
      const plan = planRow(contextFor('people', { lookups }), {
        ...person,
        company_domain: 'acme.com',
        title: '',
      })

      expect(plan.action === 'create' && 'affiliation' in plan.write).toBe(false)
    })

    it('warns and skips the position when the company is absent under skip', () => {
      const plan = planRow(contextFor('people', { onMissingCompany: 'skip' }), {
        ...person,
        company_domain: 'nowhere.test',
        title: 'Engineer',
      })

      expect(plan.action).toBe('create')
      expect(plan.action === 'create' && 'affiliation' in plan.write).toBe(false)
      expect(plan.action === 'create' && plan.warnings?.[0]).toMatchObject({ field: 'company_domain' })
    })

    it('plans a company create when it is absent under create', () => {
      const plan = planRow(contextFor('people', { onMissingCompany: 'create' }), {
        ...person,
        company_domain: 'newfirm.test',
        company_name: 'New Firm',
        title: 'Engineer',
      })

      expect(plan).toMatchObject({
        write: {
          affiliation: {
            kind: 'create',
            company: { name: 'New Firm', domain: 'newfirm.test' },
            title: 'Engineer',
          },
        },
      })
    })

    it('lets the domain decide when the row carries both', () => {
      const plan = planRow(
        contextFor('people', {
          onMissingCompany: 'create',
          lookups: { companyIdByName: new Map([['acme', 'com_name']]) },
        }),
        { ...person, company_domain: 'newfirm.test', company_name: 'Acme', title: 'Engineer' },
      )

      // Domain is present but unknown, so this is a create, not a link to the
      // name match. The name only resolves a row with no domain.
      expect(plan).toMatchObject({ write: { affiliation: { kind: 'create' } } })
    })
  })

  describe('deals', () => {
    const lookups = {
      companyIdByDomain: new Map([['acme.com', 'com_1']]),
      personIdByEmail: new Map([['ada@acme.com', 'per_1']]),
      memberIdByEmail: new Map([['sam@kelpie.test', 'mem_1']]),
      stageIdByName: new Map([
        ['qualifying', 'stage_1'],
        ['proposal', 'stage_2'],
        ['in discussion', 'stage_2'],
      ]),
    }

    const row = {
      name: 'Acme renewal',
      company_domain: 'acme.com',
      stage: 'qualifying',
      value: '1200',
      external_id: 'hs-1',
    }

    it('resolves company, stage and value', () => {
      const plan = planRow(contextFor('deals', { lookups }), row)

      expect(plan).toMatchObject({
        action: 'create',
        write: {
          object: 'deals',
          companyId: 'com_1',
          stageId: 'stage_1',
          ownerId: null,
          draft: { valueCents: 120_000 },
        },
      })
    })

    it('resolves a stage by its label as well as its slug', () => {
      const plan = planRow(contextFor('deals', { lookups }), { ...row, stage: 'In Discussion' })

      expect(plan).toMatchObject({ action: 'create', write: { stageId: 'stage_2' } })
    })

    it('resolves a vendor stage name through the alias table', () => {
      const plan = planRow(contextFor('deals', { lookups }), {
        ...row,
        stage: 'Appointment Scheduled',
      })

      expect(plan).toMatchObject({ action: 'create', write: { stageId: 'stage_1' } })
    })

    it('fails a row naming a stage this workspace does not have', () => {
      const plan = planRow(contextFor('deals', { lookups }), { ...row, stage: 'Kicking Tyres' })

      expect(plan.action === 'error' && plan.errors[0]?.field).toBe('stage')
    })

    /** `import-export.md`: a deal never creates a stub company. */
    it('fails a row whose company is not here rather than inventing one', () => {
      const plan = planRow(contextFor('deals', { lookups }), {
        ...row,
        company_domain: 'nowhere.test',
      })

      expect(plan.action === 'error' && plan.errors[0]?.field).toBe('company_domain')
    })

    it('resolves a known owner', () => {
      const plan = planRow(contextFor('deals', { lookups }), {
        ...row,
        owner_email: 'Sam@Kelpie.test',
      })

      expect(plan).toMatchObject({ action: 'create', write: { ownerId: 'mem_1' } })
    })

    /**
     * The mockup silently resolves an unknown owner to whoever ran the import.
     * Moving another person's deals onto the importer is worse data than a
     * refused row, and unmapping the column is one dropdown away.
     */
    it('fails a row naming an owner who is not in the workspace', () => {
      const plan = planRow(contextFor('deals', { lookups }), {
        ...row,
        owner_email: 'stranger@example.com',
      })

      expect(plan.action === 'error' && plan.errors[0]?.field).toBe('owner_email')
    })

    it('leaves the owner null when the column is unmapped', () => {
      expect(planRow(contextFor('deals', { lookups }), row)).toMatchObject({
        write: { ownerId: null },
      })
    })

    it('resolves the contacts a row lists', () => {
      const plan = planRow(contextFor('deals', { lookups }), {
        ...row,
        person_emails: 'ada@acme.com',
      })

      expect(plan).toMatchObject({
        write: { personIds: ['per_1'], setsPeople: true },
      })
    })

    it('fails a row listing a contact who is not here', () => {
      const plan = planRow(contextFor('deals', { lookups }), {
        ...row,
        person_emails: 'ada@acme.com|ghost@acme.com',
      })

      expect(plan.action === 'error' && plan.errors[0]?.field).toBe('person_emails')
    })

    /**
     * An empty `personIds` means two things, and only a filled-in cell is the
     * file stating the contact list. Without this an update would clear the
     * contacts of every deal in a file that never carried the column.
     */
    it('says the row set no contacts when the column is blank', () => {
      expect(planRow(contextFor('deals', { lookups }), { ...row, person_emails: '' })).toMatchObject(
        { write: { setsPeople: false } },
      )
    })
  })
})

describe('planRows', () => {
  const rows: MappedRow[] = [
    { row: 2, mapped: { name: 'Acme', domain: 'acme.com' } },
    { row: 3, mapped: { name: 'Harbour', domain: 'harbour.io' } },
    { row: 4, mapped: { name: 'Acme Corporation', domain: 'ACME.com' } },
  ]

  /**
   * Without the in-file overlay a file listing one company twice reports two
   * creates and performs one.
   */
  it('reads a repeat of an earlier row as a match, not a second create', () => {
    const planned = planRows(contextFor('companies'), rows)

    expect(planned.map((row) => row.plan.action)).toEqual(['create', 'create', 'skip'])
  })

  it('has no id for an in-file match, because the record is not written yet', () => {
    const planned = planRows(contextFor('companies'), rows)

    expect(planned[2]?.plan).toMatchObject({ action: 'skip', targetId: null })
  })

  it('updates an in-file duplicate in update mode', () => {
    const planned = planRows(contextFor('companies', { conflictMode: 'update' }), rows)

    expect(planned.map((row) => row.plan.action)).toEqual(['create', 'create', 'update'])
  })

  it('counts what the file would do', () => {
    expect(countPlans(planRows(contextFor('companies'), rows))).toEqual({
      total: 3,
      create: 2,
      update: 0,
      skip: 1,
      error: 0,
    })
  })

  it('counts a failing row once however many things are wrong with it', () => {
    const counts = countPlans(
      planRows(contextFor('people'), [
        { row: 2, mapped: { name: 'Ada', email: 'ada@acme.com', influence: 'x', relationship: 'y' } },
      ]),
    )

    expect(counts).toMatchObject({ total: 1, error: 1, create: 0 })
  })
})
