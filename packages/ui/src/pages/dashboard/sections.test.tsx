import type { DashboardActivity, DashboardNote } from '@kelpie/schemas'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ActivityFeed, NotesList } from './sections.tsx'

/**
 * Who the dashboard names beside a note or an activity. A member who has
 * gone leaves their notes and their timeline behind with nobody named, and
 * the dashboard must not pass that off as the system's work.
 */

const NOW = new Date('2026-08-02T00:00:00.000Z')
const NAMES: ReadonlyMap<string, string> = new Map([['mem_1', 'Ada Lovelace']])

function note(overrides: Partial<DashboardNote> = {}): DashboardNote {
  return {
    id: 'note_1',
    targetType: 'person',
    targetId: 'per_1',
    targetName: 'Grace Hopper',
    body: 'Cares about implementation.',
    authorId: 'mem_1',
    origin: 'member',
    pinned: false,
    references: [],
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  }
}

function activity(overrides: Partial<DashboardActivity> = {}): DashboardActivity {
  return {
    id: 'act_1',
    targetType: 'person',
    targetId: 'per_1',
    targetName: 'Grace Hopper',
    kind: 'created',
    actorMemberId: 'mem_1',
    actorLabel: null,
    action: 'created Person',
    detail: null,
    references: [],
    subject: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  }
}

function renderNotes(notes: readonly DashboardNote[]): void {
  render(
    <MemoryRouter>
      <NotesList notes={notes} nameById={NAMES} now={NOW} timezone="UTC" />
    </MemoryRouter>,
  )
}

function renderActivities(activities: readonly DashboardActivity[]): void {
  render(
    <MemoryRouter>
      <ActivityFeed activities={activities} nameById={NAMES} now={NOW} timezone="UTC" />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
})

describe('NotesList', () => {
  it('names the member who wrote a note', () => {
    renderNotes([note()])

    expect(screen.getByText('Ada Lovelace')).toBeTruthy()
  })

  it('reads a null author on a note a member wrote as a former member', () => {
    renderNotes([note({ authorId: null, origin: 'member' })])

    expect(screen.getByText('Former member')).toBeTruthy()
    expect(screen.queryByText('System')).toBeNull()
  })

  it('shows no author name on a note an agent wrote with no member behind it', () => {
    renderNotes([note({ authorId: null, origin: 'agent' })])

    expect(screen.getByText('Written by an agent')).toBeTruthy()
    expect(screen.queryByText('API key')).toBeNull()
    expect(screen.queryByText('System')).toBeNull()
  })

  it('names a null author on a note from before origin was recorded as the workspace key, as the notes panel does', () => {
    renderNotes([note({ authorId: null, origin: 'unknown' })])

    expect(screen.getByText('API key')).toBeTruthy()
  })
})

describe('ActivityFeed', () => {
  it('uses the actor label when nothing on the team did it', () => {
    renderActivities([activity({ actorMemberId: null, actorLabel: 'Form' })])

    expect(screen.getByText('Form')).toBeTruthy()
  })

  it('reads a row with neither a member nor a label as a former member', () => {
    renderActivities([activity({ actorMemberId: null, actorLabel: null })])

    expect(screen.getByText('Former member')).toBeTruthy()
  })
})
