import {
  PERSON_INTAKE_KIND_LABELS,
  PERSON_INTAKE_KINDS,
  PERSON_INTAKE_PERSON_KEY,
  personIntakeCandidateBody,
  personIntakeDependencies,
  personIntakeCandidateSchema,
} from '@kelpie/schemas'
import type {
  PersonIntakeCandidate,
  PersonIntakeCandidateWire,
  PersonIntakeIdentifyResult,
  PersonIntakeItem,
  PersonIntakeKind,
  PersonIntakeResearchResult,
  PersonIntakeResult,
  PersonIntakeResultStatus,
  PersonIntakeSavedRun,
  PersonIntakeSource,
} from '@kelpie/schemas'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'

import { useAiServiceLabel } from '../api/resources/ai.ts'
import {
  useApplyPersonIntake,
  usePersonIntakeRun,
  useStartIdentify,
  useStartResearch,
} from '../api/resources/personIntake.ts'
import { useSession } from '../api/resources/session.ts'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { IntakeFrame, NotesField } from '../components/PersonIntakePanel.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { clearSavedIntakeRuns, readSavedIntakeRun, saveIntakeRun } from '../lib/personIntakeRunStorage.ts'
import type { PersonIntakeWizardProps } from '../registry/contributions.ts'
import { effectiveSelection } from './personIntakeSelection.ts'

/**
 * The `ai` module's wizard behind People's **Add from notes**: notes, confirm the
 * person, choose what to create, done. Spec: person intake, in the `ai`
 * module's docs (`docs/agents/kelpie-ai.md`).
 *
 * The wizard holds no records of its own. `identify` and `research` each start
 * an AI run on the server, and the wizard reads the run every 2 seconds until
 * it settles. The run and the step are kept in `sessionStorage`, so a reload
 * picks the task up again; the server keeps a run's result for an hour. The
 * last step writes only the ticked items.
 */

/**
 * What the Confirm step shows. It names no run: when the step is rebuilt from
 * a saved candidate after a reload, the identify run that found the person
 * may be gone, and there is no id to give it. The run, when it is still known,
 * is the step's `identifyRunId`.
 */
type Identified = Omit<PersonIntakeIdentifyResult, 'runId'>

type Step =
  | { readonly kind: 'restoring'; readonly saved: PersonIntakeSavedRun['step'] }
  | { readonly kind: 'notes' }
  | {
      readonly kind: 'confirm'
      readonly identified: Identified
      /** The identify run behind this step, when its result is still on the server. */
      readonly identifyRunId: string | null
      readonly target?: string | null
    }
  | { readonly kind: 'choose'; readonly research: PersonIntakeResearchResult }
  | { readonly kind: 'done'; readonly results: readonly PersonIntakeResult[] }

/** A run the wizard is waiting on, and what it was started with. */
interface WatchedRun {
  readonly runId: string
  readonly text: string
  /** The identify run a research run was started from. */
  readonly identifyRunId: string | null
  /** The confirmed person, for a research run. */
  readonly candidate: PersonIntakeCandidateWire | null
  readonly existingPersonId: string | null
  /**
   * After a reload of a failed research run, the person it was started with.
   * The wizard reads the identify run again for the full Confirm step; when
   * that run or its result has gone, it rebuilds Confirm from this instead.
   */
  readonly fallback: { readonly candidate: PersonIntakeCandidateWire; readonly existingPersonId: string | null } | null
}

/** What the wizard keeps for a reload, less the user it belongs to. */
type SavedState = Omit<PersonIntakeSavedRun, 'user_id'>

const STEP_LABELS = ['Notes', 'Confirm', 'Choose', 'Done'] as const

const STEP_INDEX: Readonly<Record<Exclude<Step['kind'], 'restoring'>, number>> = {
  notes: 0,
  confirm: 1,
  choose: 2,
  done: 3,
}

/** Shown, with the notes still filled in, when a run's result has gone. */
const RESULT_GONE_MESSAGE = 'This result is no longer available. Start again.'

/** Pipeline records start unticked: the model suggests them, the user decides. */
const OFF_BY_DEFAULT: ReadonlySet<PersonIntakeKind> = new Set(['partnership', 'deal', 'enquiry'])

const primaryButton =
  'rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50'
const secondaryButton =
  'rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink disabled:opacity-50'

/** The Confirm step for a research run, rebuilt from the person it was started with. */
function confirmFrom(
  candidate: PersonIntakeCandidateWire | null,
  identifyRunId: string | null,
  existingPersonId: string | null,
): Step {
  if (candidate === null) return { kind: 'notes' }

  return {
    kind: 'confirm',
    identified: { candidates: [personIntakeCandidateSchema.parse(candidate)], question: null, sources: [] },
    identifyRunId,
    target: existingPersonId,
  }
}

function confirmFor(watched: WatchedRun): Step {
  return confirmFrom(watched.candidate, watched.identifyRunId, watched.existingPersonId)
}

function stepIndex(step: Step): number {
  return step.kind === 'restoring' ? STEP_INDEX[step.saved] : STEP_INDEX[step.kind]
}

/**
 * Where a reload starts: the run to read, or, for a run that failed, the step
 * and the notes alone. A failed research run reads its identify run again,
 * while that result is kept, to rebuild the Confirm step.
 */
function restoredState(saved: PersonIntakeSavedRun | undefined): { step: Step; watched: WatchedRun | undefined } {
  if (saved === undefined) return { step: { kind: 'notes' }, watched: undefined }

  const runId = saved.run_id ?? (saved.step === 'confirm' ? saved.identify_run_id : null)

  if (runId !== null) {
    return {
      step: { kind: 'restoring', saved: saved.step },
      watched: {
        runId,
        text: saved.text,
        identifyRunId: saved.run_id === null ? null : saved.identify_run_id,
        candidate: saved.run_id === null ? null : saved.candidate,
        existingPersonId: saved.run_id === null ? null : saved.existing_person_id,
        fallback:
          saved.run_id === null && saved.candidate !== null
            ? { candidate: saved.candidate, existingPersonId: saved.existing_person_id }
            : null,
      },
    }
  }

  return {
    step: saved.step === 'confirm' ? confirmFrom(saved.candidate, null, saved.existing_person_id) : { kind: 'notes' },
    watched: undefined,
  }
}

export function PersonIntakeWizard(props: PersonIntakeWizardProps): React.JSX.Element {
  const { session } = useSession()

  // The saved run is per workspace and user, so the wizard waits until it knows both.
  if (session === undefined) return <LoadingPanel label="Loading…" />

  return (
    <IntakeWizard
      key={`${session.workspaceId ?? ''}:${session.userId}`}
      {...props}
      workspaceId={session.workspaceId}
      userId={session.userId}
    />
  )
}

function IntakeWizard({
  onClose,
  onPendingChange,
  workspaceId,
  userId,
}: PersonIntakeWizardProps & { readonly workspaceId: string | null; readonly userId: string }): React.JSX.Element {
  const [restored] = useState(() => {
    const saved = workspaceId === null ? undefined : readSavedIntakeRun(workspaceId, userId)

    return { ...restoredState(saved), text: saved?.text ?? '' }
  })
  const [step, setStep] = useState<Step>(restored.step)
  const [text, setText] = useState(restored.text)
  const [watched, setWatched] = useState<WatchedRun | undefined>(restored.watched)
  /** Why the last run failed, from the server. Shown as written: it is the run log's reason. */
  const [runFailure, setRunFailure] = useState<string | null>(null)
  const [resultGone, setResultGone] = useState(false)
  const identify = useStartIdentify()
  const research = useStartResearch()
  const apply = useApplyPersonIntake()
  const polled = usePersonIntakeRun(watched?.runId)
  // While a run is watched, even one the wizard cannot read just now, nothing
  // new starts: the server run goes on, and a second would spend another.
  const pending = identify.isPending || research.isPending || apply.isPending || watched !== undefined
  const readError = watched !== undefined && !polled.isNotFound ? polled.error : null

  useEffect(() => {
    onPendingChange?.(pending)
  }, [pending, onPendingChange])

  // Moves the wizard on when the run it waits on changes, once per settled run.
  useEffect(() => {
    if (watched === undefined) return

    function keep(state: SavedState): void {
      if (workspaceId !== null) saveIntakeRun(workspaceId, { user_id: userId, ...state })
    }

    function forget(): void {
      if (workspaceId !== null) clearSavedIntakeRuns(workspaceId)
    }

    /** The run's result has gone: Confirm from the saved person when there is one, else the notes. */
    function resultGoneFor(current: WatchedRun): void {
      setWatched(undefined)

      if (current.fallback !== null) {
        setStep(confirmFrom(current.fallback.candidate, null, current.fallback.existingPersonId))
        keep({
          run_id: null,
          identify_run_id: null,
          step: 'confirm',
          text: current.text,
          candidate: current.fallback.candidate,
          existing_person_id: current.fallback.existingPersonId,
        })
        return
      }

      setResultGone(true)
      setStep({ kind: 'notes' })
      forget()
    }

    if (polled.isNotFound) {
      resultGoneFor(watched)
      return
    }

    if (polled.error !== null) {
      // The run may still finish. Keep watching it, and show the error with
      // a way to read it again; the step leaves the loading state.
      setStep((current) => (current.kind === 'restoring' ? confirmOrNotes(watched) : current))
      return
    }

    const run = polled.run
    if (run === undefined) return

    if (run.status === 'queued' || run.status === 'running') {
      setStep((current) =>
        current.kind !== 'restoring' ? current : run.kind === 'identify' ? { kind: 'notes' } : confirmFor(watched),
      )
      return
    }

    setWatched(undefined)

    if (run.status === 'failed') {
      setRunFailure(run.failureReason ?? 'The AI run failed.')
      setStep((current) =>
        current.kind === 'confirm' ? current : run.kind === 'identify' ? { kind: 'notes' } : confirmFor(watched),
      )
      // The step and the notes stay saved, with no run to wait on.
      keep({
        run_id: null,
        identify_run_id: run.kind === 'research' ? watched.identifyRunId : null,
        step: run.kind === 'identify' ? 'notes' : 'confirm',
        text: watched.text,
        candidate: run.kind === 'research' ? watched.candidate : null,
        existing_person_id: run.kind === 'research' ? watched.existingPersonId : null,
      })
      return
    }

    if (run.kind === 'identify' && run.result !== null) {
      setStep({ kind: 'confirm', identified: run.result, identifyRunId: run.runId })
      keep({
        run_id: run.runId,
        identify_run_id: null,
        step: 'confirm',
        text: watched.text,
        candidate: null,
        existing_person_id: null,
      })
      return
    }

    if (run.kind === 'research' && run.result !== null) {
      setStep({ kind: 'choose', research: run.result })
      keep({
        run_id: run.runId,
        identify_run_id: watched.identifyRunId,
        step: 'choose',
        text: watched.text,
        candidate: watched.candidate,
        existing_person_id: watched.existingPersonId,
      })
      return
    }

    // Succeeded, and the hour has passed: the result is gone.
    resultGoneFor(watched)
  }, [watched, polled.run, polled.error, polled.isNotFound, workspaceId, userId])

  function remember(run: WatchedRun, savedStep: PersonIntakeSavedRun['step']): void {
    setWatched(run)
    if (workspaceId === null) return

    saveIntakeRun(workspaceId, {
      user_id: userId,
      run_id: run.runId,
      identify_run_id: run.identifyRunId,
      step: savedStep,
      text: run.text,
      candidate: run.candidate,
      existing_person_id: run.existingPersonId,
    })
  }

  function forgetSaved(): void {
    if (workspaceId !== null) clearSavedIntakeRuns(workspaceId)
  }

  async function runIdentify(): Promise<void> {
    setRunFailure(null)
    setResultGone(false)
    const notes = text.trim()
    const started = await identify.runAsync(notes)
    remember(
      { runId: started.runId, text: notes, identifyRunId: null, candidate: null, existingPersonId: null, fallback: null },
      'notes',
    )
  }

  async function runResearch(
    candidate: PersonIntakeCandidate,
    existingPersonId: string | null,
    identifyRunId: string | null,
  ): Promise<void> {
    setRunFailure(null)
    const notes = text.trim()
    const started = await research.runAsync({ text: notes, candidate, existingPersonId })
    remember(
      {
        runId: started.runId,
        text: notes,
        identifyRunId,
        candidate: personIntakeCandidateBody(candidate),
        existingPersonId,
        fallback: null,
      },
      'confirm',
    )
  }

  async function runApply(items: readonly PersonIntakeItem[]): Promise<void> {
    const applied = await apply.runAsync(items)
    setStep({ kind: 'done', results: applied.results })
    forgetSaved()
  }

  function startAgain(): void {
    setRunFailure(null)
    setStep({ kind: 'notes' })
    forgetSaved()
  }

  return (
    <>
      <StepBar current={stepIndex(step)} />
      {readError !== null && (
        <div role="alert" className="border-b border-border px-4 py-3">
          <ErrorPanel error={readError} />
          <p className="mt-2 text-[12px] text-ink-muted">
            The run may still be working. Kelpie will not start another until this one is read.
          </p>
          <button
            type="button"
            className={`${secondaryButton} mt-1`}
            onClick={() => {
              polled.refetch()
            }}
          >
            Check again
          </button>
        </div>
      )}
      {step.kind === 'restoring' && <LoadingPanel label="Picking up where you left off…" />}
      {step.kind === 'notes' && (
        <NotesStep
          text={text}
          onChange={setText}
          pending={pending}
          error={identify.error}
          failure={runFailure}
          notice={resultGone ? RESULT_GONE_MESSAGE : null}
          onNext={() => {
            void runIdentify().catch(() => undefined)
          }}
        />
      )}
      {step.kind === 'confirm' && (
        <ConfirmStep
          identified={step.identified}
          initialTarget={step.target}
          pending={pending}
          error={research.error}
          failure={runFailure}
          onBack={startAgain}
          onNext={(candidate, existingPersonId) => {
            void runResearch(candidate, existingPersonId, step.identifyRunId).catch(() => undefined)
          }}
        />
      )}
      {step.kind === 'choose' && (
        <ChooseStep
          research={step.research}
          pending={apply.isPending}
          error={apply.error}
          onBack={startAgain}
          onNext={(items) => {
            void runApply(items).catch(() => undefined)
          }}
        />
      )}
      {step.kind === 'done' && <DoneStep results={step.results} onClose={onClose} />}
    </>
  )
}

/**
 * Where a run the wizard could not read leaves it: the Confirm step for
 * research, or for a reload of a failed research run the saved person's
 * Confirm step, else the notes.
 */
function confirmOrNotes(watched: WatchedRun): Step {
  if (watched.candidate !== null) return confirmFor(watched)
  if (watched.fallback !== null) return confirmFrom(watched.fallback.candidate, null, watched.fallback.existingPersonId)

  return { kind: 'notes' }
}

/** A failed run's reason. The server wrote it for the user, so it is shown as it is. */
function RunFailure({ reason }: { readonly reason: string }): React.JSX.Element {
  return (
    <div role="alert" className="mt-3 rounded-md border border-danger/40 bg-danger-soft px-4 py-3">
      <p className="text-[13px] font-medium text-danger">{reason}</p>
    </div>
  )
}

function StepBar({ current }: { readonly current: number }): React.JSX.Element {
  return (
    <ol className="flex gap-4 border-b border-border px-4 py-2 text-[11px]">
      {STEP_LABELS.map((label, index) => (
        <li
          key={label}
          aria-current={index === current ? 'step' : undefined}
          className={index === current ? 'font-semibold text-ink' : index < current ? 'text-ink-muted' : 'text-ink-faint'}
        >
          {String(index + 1)}. {label}
        </li>
      ))}
    </ol>
  )
}

function NotesStep({
  text,
  onChange,
  pending,
  error,
  notice,
  failure,
  onNext,
}: {
  readonly text: string
  readonly onChange: (value: string) => void
  readonly pending: boolean
  readonly error: Error | null
  /** Why the run failed, as the server put it. */
  readonly failure: string | null
  /** A line above the notes, such as the result having gone. */
  readonly notice: string | null
  readonly onNext: () => void
}): React.JSX.Element {
  const serviceLabel = useAiServiceLabel()
  return (
    <IntakeFrame
      footer={
        <button type="button" className={primaryButton} disabled={pending || text.trim().length === 0} onClick={onNext}>
          {pending ? 'Looking them up…' : 'Find this person'}
        </button>
      }
    >
      {notice !== null && (
        <p role="status" className="mb-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[12px] text-ink">
          {notice}
        </p>
      )}
      <NotesField value={text} onChange={onChange} disabled={pending} />
      {pending && (
        <p className="mt-2 text-[12px] text-ink-muted">
          {serviceLabel} is looking this person up. With web search on, this can take a minute. You can keep working: this task stays open in the drawer.
        </p>
      )}
      {error !== null && (
        <div className="mt-3">
          <ErrorPanel error={error} />
        </div>
      )}
      {failure !== null && <RunFailure reason={failure} />}
    </IntakeFrame>
  )
}

const CONFIDENCE_TONES: Readonly<Record<PersonIntakeCandidate['confidence'], ChipTone>> = {
  high: 'success',
  medium: 'warning',
  low: 'neutral',
}

/** `'new'`, or the id of the existing Person to add to. */
type Target = string

function ConfirmStep({
  identified,
  initialTarget,
  pending,
  error,
  failure,
  onBack,
  onNext,
}: {
  readonly identified: Identified
  /** The target a research run was started with, when the step is rebuilt after a reload. */
  readonly initialTarget?: string | null | undefined
  readonly pending: boolean
  readonly error: Error | null
  /** Why the research run failed, as the server put it. */
  readonly failure: string | null
  readonly onBack: () => void
  readonly onNext: (candidate: PersonIntakeCandidate, existingPersonId: string | null) => void
}): React.JSX.Element {
  const serviceLabel = useAiServiceLabel()
  const first = identified.candidates[0]
  const [candidateKey, setCandidateKey] = useState(first?.key ?? '')
  const [target, setTarget] = useState<Target>(
    initialTarget === undefined ? (first?.existingPeople[0]?.id ?? 'new') : (initialTarget ?? 'new'),
  )
  const candidate = identified.candidates.find((entry) => entry.key === candidateKey)

  if (identified.candidates.length === 0) {
    return (
      <IntakeFrame
        footer={
          <button type="button" className={primaryButton} onClick={onBack}>
            Add more detail
          </button>
        }
      >
        <p className="text-[13px] font-medium text-ink">{serviceLabel} could not tell who this is.</p>
        {identified.question !== null && <p className="mt-1 text-[13px] text-ink-muted">{identified.question}</p>}
      </IntakeFrame>
    )
  }

  return (
    <IntakeFrame
      footer={
        <>
          <button type="button" className={secondaryButton} disabled={pending} onClick={onBack}>
            Back
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={pending || candidate === undefined}
            onClick={() => {
              if (candidate !== undefined) onNext(candidate, target === 'new' ? null : target)
            }}
          >
            {pending ? 'Researching…' : 'This is them: research'}
          </button>
        </>
      }
    >
      <fieldset disabled={pending}>
        <legend className="mb-2 text-[12px] font-medium text-ink-muted">
          {identified.candidates.length === 1 ? 'Is this the right person?' : 'Which of these is the right person?'}
        </legend>
        <div className="space-y-2">
          {identified.candidates.map((entry) => (
            <label
              key={entry.key}
              className={[
                'block cursor-pointer rounded-md border px-3 py-2',
                entry.key === candidateKey ? 'border-accent bg-accent-soft/40' : 'border-border hover:border-border-strong',
              ].join(' ')}
            >
              <span className="flex items-start gap-2">
                <input
                  type="radio"
                  name="candidate"
                  className="mt-1"
                  checked={entry.key === candidateKey}
                  onChange={() => {
                    setCandidateKey(entry.key)
                    setTarget(entry.existingPeople[0]?.id ?? 'new')
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink">{entry.name}</span>
                    <Chip tone={CONFIDENCE_TONES[entry.confidence]}>{entry.confidence} confidence</Chip>
                  </span>
                  {entry.headline !== '' && <span className="block text-[12px] text-ink">{entry.headline}</span>}
                  <span className="block text-[12px] text-ink-muted">
                    {[entry.location, entry.email].filter((part) => part !== null && part !== '').join(' · ')}
                  </span>
                  {entry.profileUrls.length > 0 && (
                    <span className="mt-0.5 flex flex-wrap gap-x-3 text-[12px]">
                      {entry.profileUrls.map((url) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                          {hostOf(url)}
                        </a>
                      ))}
                    </span>
                  )}
                  {entry.evidence !== '' && <span className="mt-1 block text-[12px] text-ink-muted">{entry.evidence}</span>}
                </span>
              </span>
            </label>
          ))}
        </div>

        {candidate !== undefined && candidate.existingPeople.length > 0 && (
          <div className="mt-4 rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
            <p className="text-[12px] font-medium text-ink">This may already be in Kelpie.</p>
            <div className="mt-1 space-y-1">
              {candidate.existingPeople.map((person) => (
                <label key={person.id} className="flex items-center gap-2 text-[12px] text-ink">
                  <input
                    type="radio"
                    name="target"
                    checked={target === person.id}
                    onChange={() => {
                      setTarget(person.id)
                    }}
                  />
                  Update{' '}
                  <Link to={`/people/${person.id}`} target="_blank" className="font-medium text-accent hover:underline">
                    {person.name}
                  </Link>
                  {person.email !== null && <span className="text-ink-muted">{person.email}</span>}
                </label>
              ))}
              <label className="flex items-center gap-2 text-[12px] text-ink">
                <input
                  type="radio"
                  name="target"
                  checked={target === 'new'}
                  onChange={() => {
                    setTarget('new')
                  }}
                />
                Create a new person
              </label>
            </div>
          </div>
        )}
      </fieldset>
      {pending && (
        <p className="mt-3 text-[12px] text-ink-muted">
          {serviceLabel} is researching this person. With web search on, this can take a minute. You can keep working: this task stays open in the drawer.
        </p>
      )}
      <Sources sources={identified.sources} />
      {error !== null && (
        <div className="mt-3">
          <ErrorPanel error={error} />
        </div>
      )}
      {failure !== null && <RunFailure reason={failure} />}
    </IntakeFrame>
  )
}

function ChooseStep({
  research,
  pending,
  error,
  onBack,
  onNext,
}: {
  readonly research: PersonIntakeResearchResult
  readonly pending: boolean
  readonly error: Error | null
  readonly onBack: () => void
  readonly onNext: (items: readonly PersonIntakeItem[]) => void
}): React.JSX.Element {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(research.items.filter((item) => !OFF_BY_DEFAULT.has(item.kind)).map((item) => item.key)),
  )
  const effective = effectiveSelection(research.items, ticked)
  const chosen = research.items.filter((item) => effective.has(item.key))
  const companyNames = new Map(
    research.items.flatMap((item) => (item.kind === 'company' ? [[item.key, item.fields.name] as const] : [])),
  )
  const ordered = [...research.items].sort(
    (left, right) => PERSON_INTAKE_KINDS.indexOf(left.kind) - PERSON_INTAKE_KINDS.indexOf(right.kind),
  )

  function toggle(key: string): void {
    setTicked((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <IntakeFrame
      footer={
        <>
          <button type="button" className={secondaryButton} disabled={pending} onClick={onBack}>
            Start again
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={pending || chosen.length === 0}
            onClick={() => {
              onNext(chosen)
            }}
          >
            {pending ? 'Creating…' : `Create ${String(chosen.length)} ${chosen.length === 1 ? 'item' : 'items'}`}
          </button>
        </>
      }
    >
      {research.summary !== '' && <p className="mb-3 text-[13px] text-ink">{research.summary}</p>}
      <p className="mb-2 text-[12px] font-medium text-ink-muted">Kelpie will create what you tick.</p>
      <ul className="space-y-1.5">
        {ordered.map((item) => {
          const blocked = ticked.has(item.key) && !effective.has(item.key)
          const missing = personIntakeDependencies(item).filter((key) => !effective.has(key))

          return (
            <li key={item.key}>
              <label
                className={[
                  'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2',
                  effective.has(item.key) ? 'border-border-strong' : 'border-border',
                  missing.length > 0 ? 'opacity-60' : '',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={effective.has(item.key)}
                  disabled={pending || missing.length > 0}
                  onChange={() => {
                    toggle(item.key)
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Chip tone={item.kind === 'person' ? 'accent' : 'neutral'}>{PERSON_INTAKE_KIND_LABELS[item.kind]}</Chip>
                    <span className="text-[13px] font-medium text-ink">{itemTitle(item, companyNames)}</span>
                    {actionNote(item) !== null && <span className="text-[11px] text-ink-muted">{actionNote(item)}</span>}
                  </span>
                  <ItemDetail item={item} />
                  {(missing.length > 0 || blocked) && (
                    <span className="mt-0.5 block text-[11px] text-ink-muted">
                      Needs the {missing.map((key) => describeKey(key, research.items)).join(' and ')} ticked.
                    </span>
                  )}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <Sources sources={research.sources} />
      {error !== null && (
        <div className="mt-3">
          <ErrorPanel error={error} />
        </div>
      )}
    </IntakeFrame>
  )
}

function describeKey(key: string, items: readonly PersonIntakeItem[]): string {
  const item = items.find((entry) => entry.key === key)

  if (item === undefined) return key === PERSON_INTAKE_PERSON_KEY ? 'person' : 'company'

  return item.kind === 'company' || item.kind === 'person' ? `${item.kind} ${item.fields.name}` : item.kind
}

function itemTitle(item: PersonIntakeItem, companyNames: ReadonlyMap<string, string>): string {
  switch (item.kind) {
    case 'person':
    case 'company':
    case 'partnership':
    case 'deal':
    case 'enquiry':
      return item.fields.name
    case 'position': {
      const company = companyNames.get(item.companyKey) ?? 'the company'
      return item.title === '' ? `At ${company}` : `${item.title} at ${company}`
    }
    case 'note':
      return 'Research note'
  }
}

function actionNote(item: PersonIntakeItem): string | null {
  if (item.kind === 'person' && item.action === 'update') return 'Adds to the existing record'
  if (item.kind === 'company' && item.action === 'existing') return 'Already in Kelpie; links to it'
  return null
}

function ItemDetail({ item }: { readonly item: PersonIntakeItem }): React.JSX.Element | null {
  const muted = 'mt-0.5 block text-[12px] text-ink-muted'

  switch (item.kind) {
    case 'person': {
      const fields = item.fields
      const facts = [
        fields.email ?? null,
        fields.phones !== undefined && fields.phones.length > 0 ? fields.phones.join(', ') : null,
        fields.socialProfiles !== undefined && fields.socialProfiles.length > 0
          ? fields.socialProfiles.map((profile) => profile.network).join(', ')
          : null,
        fields.tags !== undefined && fields.tags.length > 0 ? `Tags: ${fields.tags.join(', ')}` : null,
      ].filter((fact): fact is string => fact !== null && fact !== '')

      return (
        <>
          {facts.length > 0 && <span className={muted}>{facts.join(' · ')}</span>}
          {fields.summary !== undefined && fields.summary !== '' && <span className={muted}>{fields.summary}</span>}
        </>
      )
    }
    case 'company': {
      if (item.action === 'existing') return null
      const fields = item.fields
      const facts = [fields.domain ?? null, fields.industry ?? null, fields.sizeBand ?? null].filter(
        (fact): fact is string => fact !== null && fact !== '',
      )
      return (
        <>
          {facts.length > 0 && <span className={muted}>{facts.join(' · ')}</span>}
          {fields.description !== undefined && fields.description !== '' && (
            <span className={muted}>{fields.description}</span>
          )}
        </>
      )
    }
    case 'position':
      return null
    case 'note':
      return <span className={`${muted} line-clamp-4 whitespace-pre-wrap`}>{item.body}</span>
    case 'partnership':
    case 'deal':
    case 'enquiry':
      return item.reason === '' ? null : <span className={`${muted} italic`}>Why: {item.reason}</span>
  }
}

function Sources({ sources }: { readonly sources: readonly PersonIntakeSource[] }): React.JSX.Element | null {
  if (sources.length === 0) return null

  return (
    <div className="mt-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Sources</p>
      <ul className="mt-1 space-y-0.5">
        {sources.map((source) => (
          <li key={source.url} className="truncate text-[12px]">
            <a href={source.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
              {source.title === source.url ? hostOf(source.url) : source.title}
            </a>{' '}
            <span className="text-ink-faint">{hostOf(source.url)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const STATUS_TONES: Readonly<Record<PersonIntakeResultStatus, ChipTone>> = {
  created: 'success',
  updated: 'success',
  linked: 'neutral',
  skipped: 'warning',
  failed: 'danger',
}

/** Where a written item lives. Positions and notes show on their Person. */
function pathFor(result: PersonIntakeResult, personId: string | null): string | null {
  if (result.id === null) return null

  switch (result.kind) {
    case 'person':
      return `/people/${result.id}`
    case 'company':
      return `/companies/${result.id}`
    case 'position':
    case 'note':
      return personId === null ? null : `/people/${personId}`
    case 'partnership':
      return `/partnerships/${result.id}`
    case 'deal':
      return `/deals/${result.id}`
    case 'enquiry':
      return `/enquiries/${result.id}`
  }
}

function DoneStep({
  results,
  onClose,
}: {
  readonly results: readonly PersonIntakeResult[]
  readonly onClose: () => void
}): React.JSX.Element {
  const person = results.find((result) => result.kind === 'person' && result.id !== null)
  const personId = person?.id ?? null
  const problems = results.filter((result) => result.status === 'failed' || result.status === 'skipped').length

  return (
    <IntakeFrame
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Close
          </button>
          {person !== undefined && personId !== null && (
            <Link to={`/people/${personId}`} className={primaryButton}>
              Open {person.label}
            </Link>
          )}
        </>
      }
    >
      <p className="mb-2 text-[13px] text-ink">
        {problems === 0 ? 'Done. Kelpie wrote these records.' : 'Done, with problems. Check the items marked below.'}
      </p>
      <ul className="space-y-1.5">
        {results.map((result) => {
          const path = pathFor(result, personId)

          return (
            <li key={result.key} className="flex flex-wrap items-center gap-2 text-[13px]">
              <Chip tone={STATUS_TONES[result.status]}>{result.status}</Chip>
              <span className="text-[11px] text-ink-muted">{PERSON_INTAKE_KIND_LABELS[result.kind]}</span>
              {path === null ? (
                <span className="text-ink">{result.label}</span>
              ) : (
                <Link to={path} className="font-medium text-accent hover:underline">
                  {result.label}
                </Link>
              )}
              {result.detail !== null && <span className="w-full pl-1 text-[12px] text-ink-muted">{result.detail}</span>}
            </li>
          )
        })}
      </ul>
    </IntakeFrame>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '')
  } catch {
    return url
  }
}
