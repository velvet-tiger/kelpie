import { describe, expect, it } from 'vitest'

import {
  AGENT_RUN_STATUS_LABELS,
  AGENT_RUN_STATUSES,
  CANDIDATE_STATUS_LABELS,
  CANDIDATE_STATUSES,
  FIRST_INTERVIEW_STAGE,
  FORM_FIELD_MAP_TARGET_LABELS,
  FORM_FIELD_MAP_TARGETS,
  IN_PROCESS,
  INTERVIEW_STAGE_LABELS,
  INTERVIEW_STAGES,
  PERSON_EMAIL_TARGET,
  PIPELINE_KIND_LABELS,
  PIPELINE_KINDS,
  PLAN_ITEM_STATUS_LABELS,
  PLAN_ITEM_STATUSES,
  ROLE_STATUS_LABELS,
  ROLE_STATUSES,
  SOCIAL_NETWORK_IDS,
  SOCIAL_NETWORK_LABELS,
  WEBHOOK_STATUS_LABELS,
  WEBHOOK_STATUSES,
} from './values.ts'

/**
 * Each `*_LABELS` record is keyed by its matching id array. A missing or extra
 * key means a dropdown either can't render one of the values or shows one the
 * enum no longer has, so the pairing is checked here rather than trusted.
 */
describe('label records stay in sync with their id arrays', () => {
  it.each([
    ['SOCIAL_NETWORK_LABELS', SOCIAL_NETWORK_IDS, SOCIAL_NETWORK_LABELS],
    ['ROLE_STATUS_LABELS', ROLE_STATUSES, ROLE_STATUS_LABELS],
    ['CANDIDATE_STATUS_LABELS', CANDIDATE_STATUSES, CANDIDATE_STATUS_LABELS],
    ['INTERVIEW_STAGE_LABELS', INTERVIEW_STAGES, INTERVIEW_STAGE_LABELS],
    ['PIPELINE_KIND_LABELS', PIPELINE_KINDS, PIPELINE_KIND_LABELS],
    ['PLAN_ITEM_STATUS_LABELS', PLAN_ITEM_STATUSES, PLAN_ITEM_STATUS_LABELS],
    ['WEBHOOK_STATUS_LABELS', WEBHOOK_STATUSES, WEBHOOK_STATUS_LABELS],
    ['AGENT_RUN_STATUS_LABELS', AGENT_RUN_STATUSES, AGENT_RUN_STATUS_LABELS],
    ['FORM_FIELD_MAP_TARGET_LABELS', FORM_FIELD_MAP_TARGETS, FORM_FIELD_MAP_TARGET_LABELS],
  ] as const)('%s has exactly one entry per id', (_name, ids, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...ids].sort())
  })
})

describe('derived single values', () => {
  it('FIRST_INTERVIEW_STAGE is the first of INTERVIEW_STAGES', () => {
    expect(FIRST_INTERVIEW_STAGE).toBe(INTERVIEW_STAGES[0])
  })

  it('IN_PROCESS is a real candidate status', () => {
    expect(CANDIDATE_STATUSES).toContain(IN_PROCESS)
  })

  it('PERSON_EMAIL_TARGET is a real form field map target', () => {
    expect(FORM_FIELD_MAP_TARGETS).toContain(PERSON_EMAIL_TARGET)
  })
})
