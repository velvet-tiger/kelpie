import { PIPELINE_KINDS } from '@kelpie/schemas'
import type { Form, FormAttachTarget, PipelineKind } from '@kelpie/schemas'
import { useMemo, useState } from 'react'

import { useDeals } from '../../api/resources/deals.ts'
import { useUpdateForm } from '../../api/resources/forms.ts'
import { useLists } from '../../api/resources/lists.ts'
import { useMembers } from '../../api/resources/members.ts'
import { useOpportunities } from '../../api/resources/opportunities.ts'
import { usePartnerships } from '../../api/resources/partnerships.ts'
import { usePipelineStages } from '../../api/resources/pipelineStages.ts'
import { useRaises } from '../../api/resources/raises.ts'
import { Chip } from '../../components/Chip.tsx'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'
import { toTags } from '../fields.ts'

/**
 * What the form does with a submission, once the answers are captured.
 *
 * The three create-triggers sit side by side here. Deal moved off the
 * Settings tab in the forms post-submit actions release: the form's identity
 * (name, status, thank-you copy) is one thing, and what the form *produces*
 * — a deal, an opportunity, a partnership, tagged records, list memberships,
 * pipeline attachments — is another. Actions is where a builder answers
 * "what happens next?".
 *
 * Every control commits on change; the optimistic update in
 * `createResourceHooks` puts the old value back if the PATCH is refused.
 */

const inputClass =
  'w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

export interface FormActionsProps {
  readonly form: Form
}

export function FormActions({ form }: FormActionsProps): React.JSX.Element {
  const updateForm = useUpdateForm()
  const patch = (changes: Parameters<typeof updateForm.run>[0]['changes']): void => {
    updateForm.run({ id: form.id, changes })
  }
  const hasCompanyField = form.fields.some((field) => field.mapTo.startsWith('company.'))

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader
        title="Actions"
        description="What the form creates, tags, lists, and links every submitter to."
      />

      {updateForm.error !== null && <ErrorPanel error={updateForm.error} />}

      <TriggerBlock
        form={form}
        kind="deal"
        toggle={form.createDeal}
        kindValue={null}
        stageId={form.dealStageId}
        nameTemplate={form.dealNameTemplate}
        ownerId={null}
        requiresCompany
        hasCompanyField={hasCompanyField}
        onToggle={(next) => patch({ createDeal: next })}
        onStage={(next) => patch({ dealStageId: next })}
        onTemplate={(next) => patch({ dealNameTemplate: next })}
      />

      <TriggerBlock
        form={form}
        kind="opportunity"
        toggle={form.createOpportunity}
        kindValue={form.opportunityKind}
        stageId={form.opportunityStageId}
        nameTemplate={form.opportunityNameTemplate}
        ownerId={form.opportunityOwnerId}
        onToggle={(next) => patch({ createOpportunity: next })}
        onKind={(next) => patch({ opportunityKind: next })}
        onStage={(next) => patch({ opportunityStageId: next })}
        onTemplate={(next) => patch({ opportunityNameTemplate: next })}
        onOwner={(next) => patch({ opportunityOwnerId: next })}
      />

      <TriggerBlock
        form={form}
        kind="partnership"
        toggle={form.createPartnership}
        kindValue={form.partnershipKind}
        stageId={form.partnershipStageId}
        nameTemplate={form.partnershipNameTemplate}
        ownerId={form.partnershipOwnerId}
        requiresCompany
        hasCompanyField={hasCompanyField}
        onToggle={(next) => patch({ createPartnership: next })}
        onKind={(next) => patch({ partnershipKind: next })}
        onStage={(next) => patch({ partnershipStageId: next })}
        onTemplate={(next) => patch({ partnershipNameTemplate: next })}
        onOwner={(next) => patch({ partnershipOwnerId: next })}
      />

      <TagsBlock
        title="Tag the person"
        hint="Merged into the submitter's tags. Never removes a tag someone set by hand."
        value={form.personTags}
        onChange={(next) => patch({ personTags: next })}
      />
      <TagsBlock
        title="Tag the company"
        hint="Merged into the resolved company's tags. Skipped when no company is resolved."
        value={form.companyTags}
        onChange={(next) => patch({ companyTags: next })}
      />

      <ListsBlock form={form} onChange={(next) => patch({ listIds: next })} />

      <AttachTargetsBlock form={form} onChange={(next) => patch({ attachTargets: next })} />
    </div>
  )
}

// -------- Create-trigger block --------

interface TriggerBlockProps {
  readonly form: Form
  readonly kind: PipelineKind
  readonly toggle: boolean
  readonly kindValue: string | null
  readonly stageId: string | null
  readonly nameTemplate: string | null
  readonly ownerId: string | null
  readonly requiresCompany?: boolean
  readonly hasCompanyField?: boolean
  readonly onToggle: (next: boolean) => void
  readonly onKind?: (next: string | null) => void
  readonly onStage: (next: string | null) => void
  readonly onTemplate: (next: string | null) => void
  readonly onOwner?: (next: string | null) => void
}

const TRIGGER_LABEL: Readonly<Record<PipelineKind, string>> = {
  deal: 'Create a Deal',
  opportunity: 'Create an Opportunity',
  raise: 'Create a Raise',
  partnership: 'Create a Partnership',
}

function TriggerBlock(props: TriggerBlockProps): React.JSX.Element {
  const stages = usePipelineStages(props.kind)
  const members = useMembers()
  const disabled = props.requiresCompany === true && props.hasCompanyField !== true && !props.toggle
  const showsKind = props.onKind !== undefined
  const showsOwner = props.onOwner !== undefined

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <label className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <input
          type="checkbox"
          checked={props.toggle}
          disabled={disabled}
          onChange={(event) => props.onToggle(event.target.checked)}
        />
        {TRIGGER_LABEL[props.kind]}
      </label>

      {props.requiresCompany === true && props.hasCompanyField !== true && (
        <p className="text-[12px] text-danger">
          Add a field mapped to Company · name or Company · domain first. A {props.kind} belongs to
          a company, and this form collects neither.
        </p>
      )}

      {props.toggle && (
        <>
          {showsKind && (
            <Labelled label="Kind" hint={`Required. Free text: "Grant", "Accelerator", …`}>
              <input
                className={inputClass}
                defaultValue={props.kindValue ?? ''}
                onBlur={(event) => {
                  const next = event.target.value.length === 0 ? null : event.target.value

                  if (next !== props.kindValue) {
                    props.onKind?.(next)
                  }
                }}
              />
            </Labelled>
          )}

          <Labelled
            label="Stage"
            hint="Leaving this on the first open stage follows the board, so reordering it does not strand old forms on a column that moved."
          >
            <select
              className={inputClass}
              value={props.stageId ?? ''}
              onChange={(event) => {
                props.onStage(event.target.value.length === 0 ? null : event.target.value)
              }}
            >
              <option value="">First open stage</option>
              {stages.records.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.label}
                </option>
              ))}
            </select>
          </Labelled>

          <Labelled
            label="Name template"
            hint="Tokens: {{company.name}} and {{person.name}}. A field mapped to the record's name wins over this."
          >
            <input
              className={inputClass}
              defaultValue={props.nameTemplate ?? ''}
              onBlur={(event) => {
                const next = event.target.value.length === 0 ? null : event.target.value

                if (next !== props.nameTemplate) {
                  props.onTemplate(next)
                }
              }}
            />
          </Labelled>

          {showsOwner && (
            <Labelled label="Owner" hint="Empty falls back to the workspace default member.">
              <select
                className={inputClass}
                value={props.ownerId ?? ''}
                onChange={(event) => {
                  props.onOwner?.(event.target.value.length === 0 ? null : event.target.value)
                }}
              >
                <option value="">Workspace default</option>
                {members.members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </Labelled>
          )}
        </>
      )}
    </div>
  )
}

// -------- Tags --------

function TagsBlock({
  title,
  hint,
  value,
  onChange,
}: {
  readonly title: string
  readonly hint: string
  readonly value: readonly string[]
  readonly onChange: (next: readonly string[]) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2 rounded-md border border-border p-4">
      <div className="text-[13px] font-medium text-ink">{title}</div>
      <input
        className={inputClass}
        defaultValue={value.join(', ')}
        onBlur={(event) => {
          const next = toTags(event.target.value)
          const changed =
            next.length !== value.length || next.some((tag, index) => tag !== value[index])

          if (changed) {
            onChange(next)
          }
        }}
      />
      <div className="flex flex-wrap gap-1">
        {value.map((tag) => (
          <Chip key={tag}>{tag}</Chip>
        ))}
      </div>
      <p className="text-[11px] text-ink-faint">{hint}</p>
    </div>
  )
}

// -------- Lists --------

function ListsBlock({
  form,
  onChange,
}: {
  readonly form: Form
  readonly onChange: (next: readonly string[]) => void
}): React.JSX.Element {
  const personLists = useLists({ targetType: 'person' })
  const companyLists = useLists({ targetType: 'company' })
  const eligible = useMemo(
    () => [...personLists.records, ...companyLists.records],
    [personLists.records, companyLists.records],
  )
  const eligibleById = new Map(eligible.map((list) => [list.id, list]))
  const [pick, setPick] = useState('')
  const chosen = form.listIds
  const remaining = eligible.filter((list) => !chosen.includes(list.id))

  function add(): void {
    if (pick.length === 0 || chosen.includes(pick)) {
      return
    }

    onChange([...chosen, pick])
    setPick('')
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-4">
      <div className="text-[13px] font-medium text-ink">Add to a list</div>
      <p className="text-[11px] text-ink-faint">
        Person lists get the submitter. Company lists get the resolved company, or are skipped when
        no company is resolved.
      </p>
      <ul className="divide-y divide-border">
        {chosen.length === 0 && (
          <li className="py-2 text-[12px] text-ink-faint">No lists yet.</li>
        )}
        {chosen.map((listId) => {
          const list = eligibleById.get(listId)

          return (
            <li key={listId} className="flex items-center justify-between gap-2 py-2">
              <span className="text-[13px] text-ink">
                {list === undefined ? listId : `${list.name} (${list.targetType})`}
              </span>
              <button
                type="button"
                onClick={() => onChange(chosen.filter((id) => id !== listId))}
                className="text-[11px] font-medium text-danger hover:underline"
              >
                Remove
              </button>
            </li>
          )
        })}
      </ul>
      <div className="flex items-center gap-2">
        <select
          className={`${inputClass} min-w-0 flex-1`}
          value={pick}
          onChange={(event) => setPick(event.target.value)}
        >
          <option value="">Pick a list…</option>
          {remaining.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name} ({list.targetType})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={add}
          className="shrink-0 rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
          disabled={pick.length === 0}
        >
          Add
        </button>
      </div>
    </div>
  )
}

// -------- Attach targets --------

interface AttachRecord {
  readonly id: string
  readonly name: string
}

function useAttachOptions(kind: PipelineKind): readonly AttachRecord[] {
  const deals = useDeals({}, { enabled: kind === 'deal' })
  const opportunities = useOpportunities({}, { enabled: kind === 'opportunity' })
  const raises = useRaises({}, { enabled: kind === 'raise' })
  const partnerships = usePartnerships({}, { enabled: kind === 'partnership' })

  switch (kind) {
    case 'deal':
      return deals.records.map((deal) => ({ id: deal.id, name: deal.name }))
    case 'opportunity':
      return opportunities.records.map((opp) => ({ id: opp.id, name: opp.name }))
    case 'raise':
      return raises.records.map((raise) => ({ id: raise.id, name: raise.name }))
    case 'partnership':
      return partnerships.records.map((partnership) => ({
        id: partnership.id,
        name: partnership.name,
      }))
  }
}

function AttachTargetsBlock({
  form,
  onChange,
}: {
  readonly form: Form
  readonly onChange: (next: readonly FormAttachTarget[]) => void
}): React.JSX.Element {
  const [kind, setKind] = useState<PipelineKind>('deal')
  const [pick, setPick] = useState('')
  const options = useAttachOptions(kind)
  const chosen = form.attachTargets
  const chosenKey = new Set(chosen.map((target) => `${target.targetType}:${target.targetId}`))
  const remaining = options.filter(
    (record) => !chosenKey.has(`${kind}:${record.id}`),
  )

  function add(): void {
    if (pick.length === 0) {
      return
    }

    const key = `${kind}:${pick}`

    if (chosenKey.has(key)) {
      return
    }

    onChange([...chosen, { targetType: kind, targetId: pick }])
    setPick('')
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-4">
      <div className="text-[13px] font-medium text-ink">Attach the submitter to a record</div>
      <p className="text-[11px] text-ink-faint">
        Every submitter is linked into these records through <code>person_links</code>.
      </p>
      <ul className="divide-y divide-border">
        {chosen.length === 0 && (
          <li className="py-2 text-[12px] text-ink-faint">No records yet.</li>
        )}
        {chosen.map((target) => (
          <li
            key={`${target.targetType}:${target.targetId}`}
            className="flex items-center justify-between gap-2 py-2"
          >
            <span className="text-[13px] text-ink">
              {target.targetType} · {target.targetId}
            </span>
            <button
              type="button"
              onClick={() =>
                onChange(
                  chosen.filter(
                    (candidate) =>
                      candidate.targetType !== target.targetType ||
                      candidate.targetId !== target.targetId,
                  ),
                )
              }
              className="text-[11px] font-medium text-danger hover:underline"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <select
          className={inputClass}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as PipelineKind)
            setPick('')
          }}
        >
          {PIPELINE_KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <select
          className={inputClass}
          value={pick}
          onChange={(event) => setPick(event.target.value)}
        >
          <option value="">Pick a record…</option>
          {remaining.map((record) => (
            <option key={record.id} value={record.id}>
              {record.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={add}
          className="rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
          disabled={pick.length === 0}
        >
          Add
        </button>
      </div>
    </div>
  )
}

// -------- Shared bits --------

function Labelled({
  label,
  hint,
  children,
}: {
  readonly label: string
  readonly hint?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink">{label}</span>
      {children}
      {hint !== undefined && <p className="mt-1 text-[11px] text-ink-faint">{hint}</p>}
    </label>
  )
}
