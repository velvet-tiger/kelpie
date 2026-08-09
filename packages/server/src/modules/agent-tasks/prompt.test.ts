import { describe, expect, it } from 'vitest'

import { findTask } from './catalog.ts'
import { renderPrompt } from './prompt.ts'
import type { PromptInputs } from './prompt.ts'

function inputs(overrides: Partial<PromptInputs> = {}): PromptInputs {
  return {
    workspaceName: 'Acme',
    targetLabel: 'Brightline Health',
    deepLink: '/companies/com_1',
    handbookPages: [
      {
        slug: 'ideal-customer-profile',
        title: 'Ideal customer profile',
        deepLink: '/handbook/hb_1',
      },
    ],
    pinnedNoteIds: ['note_1'],
    openPlanIds: [],
    openDecisionIds: ['dec_1'],
    related: {},
    signals: [],
    ...overrides,
  }
}

function requireTask(id: string): NonNullable<ReturnType<typeof findTask>> {
  const definition = findTask(id)

  if (definition === undefined) {
    throw new Error(`Catalog is missing ${id}`)
  }

  return definition
}

describe('renderPrompt', () => {
  it('renders the task, target, reads, and policy sections', () => {
    const prompt = renderPrompt(requireTask('company.enrich'), 'company', 'com_1', inputs())

    expect(prompt).toContain('# Agent task: Enrich company')
    expect(prompt).toContain('workspace **Acme**')
    expect(prompt).toContain('- **Id:** `company.enrich`')
    expect(prompt).toContain('- **Type:** `company`')
    expect(prompt).toContain('- **Label:** Brightline Health')
    expect(prompt).toContain('- **UI:** /companies/com_1')
    expect(prompt).toContain('1. Load the target record and agent fields.')
    expect(prompt).toContain('2. Prefer pinned notes: `note_1`.')
    expect(prompt).toContain('3. Open Plan items: (none).')
    expect(prompt).toContain('4. Open Decisions: `dec_1`.')
    expect(prompt).toContain('- `ideal-customer-profile` — Ideal customer profile (`/handbook/hb_1`)')
    expect(prompt).toContain('## Write policy')
    expect(prompt).toContain('- Respect open Decisions; do not contradict them.')
    expect(prompt).toContain('## Done when')
  })

  it('omits the related section when nothing is related', () => {
    const prompt = renderPrompt(requireTask('company.enrich'), 'company', 'com_1', inputs())

    expect(prompt).not.toContain('## Related ids')
  })

  it('renders related ids, marking a truncated list', () => {
    const prompt = renderPrompt(
      requireTask('company.enrich'),
      'company',
      'com_1',
      inputs({
        related: {
          person_ids: { ids: ['per_1', 'per_2'], truncated: false },
          deal_ids: { ids: ['deal_1'], truncated: true },
          opportunity_ids: { ids: [], truncated: false },
        },
      }),
    )

    expect(prompt).toContain('## Related ids')
    expect(prompt).toContain('- person_ids: per_1, per_2')
    expect(prompt).toContain('- deal_ids (first 1; more exist): deal_1')
    expect(prompt).not.toContain('opportunity_ids')
  })

  it('points a workspace task at the dashboard instead of a record', () => {
    const prompt = renderPrompt(
      requireTask('workspace.daily_brief'),
      'workspace',
      'ws_1',
      inputs({ targetLabel: 'Acme', deepLink: '/dashboard' }),
    )

    expect(prompt).toContain('1. Load the workspace dashboard: `GET /v1/dashboard`')
    expect(prompt).not.toContain('Load the target record')
  })

  it('renders workspace signals with exact totals and honest caps', () => {
    const prompt = renderPrompt(
      requireTask('workspace.empty_field_sweep'),
      'workspace',
      'ws_1',
      inputs({
        signals: [
          { label: 'People missing a summary', total: 3, ids: ['per_1', 'per_2', 'per_3'] },
          { label: 'Companies missing a summary', total: 40, ids: ['com_1', 'com_2'] },
          { label: 'Open raises missing a thesis fit', total: 0, ids: [] },
        ],
      }),
    )

    expect(prompt).toContain('## Workspace signals')
    expect(prompt).toContain('- People missing a summary: 3 total — per_1, per_2, per_3')
    expect(prompt).toContain('- Companies missing a summary: 40 total — com_1, com_2 (first 2)')
    expect(prompt).toContain('- Open raises missing a thesis fit: none')
  })

  it('omits the signals section for tasks with none', () => {
    const prompt = renderPrompt(requireTask('workspace.daily_brief'), 'workspace', 'ws_1', inputs())

    expect(prompt).not.toContain('## Workspace signals')
  })
})
