import {
  CANDIDATE_STATUS_LABELS,
  CANDIDATE_STATUSES,
  FIRST_INTERVIEW_STAGE,
  INTERVIEW_STAGE_LABELS,
  INTERVIEW_STAGES,
} from '@kelpie/schemas'
import type { Candidate, CandidateInput, CandidateStatus, InterviewStage } from '@kelpie/schemas'
import { useState } from 'react'

import { usePeople } from '../api/resources/people.ts'
import { useUpdateCandidate } from '../api/resources/candidates.ts'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
import { InlineEdit } from '../components/InlineEdit.tsx'

/**
 * The three editable fields of a candidacy, shared by the Role page and the
 * person's Hiring tab.
 *
 * Both pages draw them differently — a row of chips on one, a labelled grid on
 * the other, which is how the mockup draws them — so what is shared is the
 * editing rather than the layout.
 *
 * None of these knows the rule tying stage to status. Setting a status away from
 * `in_process` clears the stage server-side and setting it back restores the
 * first one, so a page sends the one field the user touched and renders whatever
 * comes back.
 */

const STATUS_OPTIONS = CANDIDATE_STATUSES.map((status) => ({
  value: status,
  label: CANDIDATE_STATUS_LABELS[status],
}))

const STAGE_OPTIONS = INTERVIEW_STAGES.map((stage) => ({
  value: stage,
  label: INTERVIEW_STAGE_LABELS[stage],
}))

const STATUS_TONES: Readonly<Record<CandidateStatus, ChipTone>> = {
  hired: 'success',
  in_process: 'accent',
  nurture: 'warning',
  passed: 'danger',
  withdrawn: 'danger',
}

function useCandidatePatch(candidate: Candidate): (changes: CandidateInput) => void {
  const update = useUpdateCandidate()

  return (changes) => {
    update.run({ id: candidate.id, changes })
  }
}

export interface CandidateFieldProps {
  readonly candidate: Candidate
  /** Rendered instead of the chip where the surrounding page uses plain text. */
  readonly plain?: boolean
}

export function CandidateStatusField({
  candidate,
  plain = false,
}: CandidateFieldProps): React.JSX.Element {
  const patch = useCandidatePatch(candidate)

  return (
    <InlineEdit
      value={candidate.status}
      onChange={(value) => {
        patch({ status: value as CandidateStatus })
      }}
      options={STATUS_OPTIONS}
      display={
        plain ? (
          <span className="px-1 text-[13px]">{CANDIDATE_STATUS_LABELS[candidate.status]}</span>
        ) : (
          <Chip tone={STATUS_TONES[candidate.status]}>
            {CANDIDATE_STATUS_LABELS[candidate.status]}
          </Chip>
        )
      }
      displayClassName={plain ? 'not-italic text-[13px]' : 'not-italic inline-flex'}
      className={plain ? '' : '!w-auto'}
    />
  )
}

export function CandidateStageField({
  candidate,
  plain = false,
}: CandidateFieldProps): React.JSX.Element {
  const patch = useCandidatePatch(candidate)
  const stage = candidate.interviewStage ?? FIRST_INTERVIEW_STAGE

  return (
    <InlineEdit
      value={stage}
      onChange={(value) => {
        patch({ interviewStage: value as InterviewStage })
      }}
      options={STAGE_OPTIONS}
      display={
        plain ? (
          <span className="px-1 text-[13px]">{INTERVIEW_STAGE_LABELS[stage]}</span>
        ) : (
          <span className="text-[12px] text-ink-muted">{INTERVIEW_STAGE_LABELS[stage]}</span>
        )
      }
      displayClassName={plain ? 'not-italic text-[13px]' : 'not-italic'}
      className={plain ? '' : '!w-auto'}
    />
  )
}

export interface CandidateReferrerFieldProps {
  readonly candidate: Candidate
  /** The referrer's name when it is already on the page, so the picker shows it. */
  readonly referrerName: string | undefined
}

/**
 * Who vouched for this candidate.
 *
 * The candidate themselves is filtered out of the options: the API refuses a
 * self-referral with a `422`, and offering a choice that cannot be made is worse
 * than not offering it.
 */
export function CandidateReferrerField({
  candidate,
  referrerName,
}: CandidateReferrerFieldProps): React.JSX.Element {
  const patch = useCandidatePatch(candidate)
  const [search, setSearch] = useState('')
  const searchable = usePeople({ term: search.trim().length > 0 ? search.trim() : undefined })

  const options = [
    ...(candidate.referrerPersonId === null
      ? []
      : [{ id: candidate.referrerPersonId, label: referrerName ?? candidate.referrerPersonId }]),
    ...searchable.records
      .filter(
        (person) => person.id !== candidate.personId && person.id !== candidate.referrerPersonId,
      )
      .map((person) => ({
        id: person.id,
        label: person.name,
        meta: person.email ?? undefined,
      })),
  ]

  return (
    <EntitySearch
      options={options}
      value={candidate.referrerPersonId ?? ''}
      onChange={(referrerPersonId) => {
        patch({ referrerPersonId: referrerPersonId.length > 0 ? referrerPersonId : null })
      }}
      onQueryChange={setSearch}
      placeholder="Search people…"
      emptyMessage="No people match"
    />
  )
}
