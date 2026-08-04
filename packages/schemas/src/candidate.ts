import { z } from 'zod'

import { CANDIDATE_STATUSES, INTERVIEW_STAGES } from './values.ts'
import type { CandidateStatus, InterviewStage } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/candidates`, the Person↔Role link.
 *
 * Hiring pipeline state sits here rather than on Person, so the same person can
 * be interviewing for one role and in the nurture pile for another. Interview
 * notes attach to the candidate, not to the person or the role.
 *
 * Neither end is updatable: moving a candidacy to a different role or person is
 * a delete and a create, the rule Position already follows.
 */

export interface Candidate extends RecordTimestamps {
  readonly id: string
  readonly roleId: string
  readonly personId: string
  readonly status: CandidateStatus
  /** Null unless the candidate is in process. The API keeps that true. */
  readonly interviewStage: InterviewStage | null
  readonly referrerPersonId: string | null
}

export const candidateSchema: z.ZodType<Candidate, unknown> = z
  .object({
    id: idSchema,
    role_id: idSchema,
    person_id: idSchema,
    status: z.enum(CANDIDATE_STATUSES),
    interview_stage: z.enum(INTERVIEW_STAGES).nullable(),
    referrer_person_id: idSchema.nullable(),
    ...recordTimestamps,
  })
  .transform(
    (wire): Candidate => ({
      id: wire.id,
      roleId: wire.role_id,
      personId: wire.person_id,
      status: wire.status,
      interviewStage: wire.interview_stage,
      referrerPersonId: wire.referrer_person_id,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CreateCandidateInput {
  readonly roleId: string
  readonly personId: string
  /** Absent means in process, where the mockup's "Add candidate" starts one. */
  readonly status?: CandidateStatus
  readonly interviewStage?: InterviewStage | null
  readonly referrerPersonId?: string | null
}

export function createCandidateBody(input: CreateCandidateInput): Record<string, unknown> {
  return definedFields({
    role_id: input.roleId,
    person_id: input.personId,
    status: input.status,
    interview_stage: input.interviewStage,
    referrer_person_id: input.referrerPersonId,
  })
}

export interface CandidateInput {
  readonly status?: CandidateStatus
  readonly interviewStage?: InterviewStage | null
  readonly referrerPersonId?: string | null
}

export function candidateBody(input: CandidateInput): Record<string, unknown> {
  return definedFields({
    status: input.status,
    interview_stage: input.interviewStage,
    referrer_person_id: input.referrerPersonId,
  })
}
