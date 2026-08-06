/**
 * Fixed value sets shared by the wire schemas and by any UI that renders a
 * dropdown over one.
 *
 * This is the only copy. `@kelpie/server`'s module schemas import from here and
 * re-export, so one array drives a table's check constraint, the route's Zod
 * enum, and the browser's decoder. The dependency runs one way: the server may
 * import this package, and this package depends on Zod and nothing else, which
 * is what keeps it usable from a browser bundle and from the cloud repo.
 */

export const PREFERRED_CHANNELS = ['email', 'call', 'linkedin'] as const
export const INFLUENCE_LEVELS = [
  'champion',
  'decision_maker',
  'influencer',
  'blocker',
  'end_user',
] as const
export const RELATIONSHIP_LEVELS = ['cold', 'warm', 'strong'] as const

export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number]
export type Influence = (typeof INFLUENCE_LEVELS)[number]
export type Relationship = (typeof RELATIONSHIP_LEVELS)[number]

export const COMPANY_STAGES = ['startup', 'growth', 'enterprise', 'other'] as const
export const SIZE_BANDS = ['1-10', '11-50', '51-200', '201+'] as const
export const ACCOUNT_TYPES = ['prospect', 'customer', 'partner', 'investor', 'other'] as const
export const ICP_FITS = ['high', 'medium', 'low', 'unknown'] as const

export type CompanyStage = (typeof COMPANY_STAGES)[number]
export type SizeBand = (typeof SIZE_BANDS)[number]
export type AccountType = (typeof ACCOUNT_TYPES)[number]
export type IcpFit = (typeof ICP_FITS)[number]

/** Networks a person can be linked on. One list beats a column per network. */
export const SOCIAL_NETWORK_IDS = [
  'angellist',
  'bluesky',
  'crunchbase',
  'facebook',
  'github',
  'instagram',
  'linkedin',
  'mastodon',
  'medium',
  'substack',
  'threads',
  'tiktok',
  'twitter',
  'youtube',
  'other',
] as const

export type SocialNetworkId = (typeof SOCIAL_NETWORK_IDS)[number]

/** Display names for `SOCIAL_NETWORK_IDS`, in the same order. */
export const SOCIAL_NETWORK_LABELS: Readonly<Record<SocialNetworkId, string>> = {
  angellist: 'AngelList',
  bluesky: 'Bluesky',
  crunchbase: 'Crunchbase',
  facebook: 'Facebook',
  github: 'GitHub',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  mastodon: 'Mastodon',
  medium: 'Medium',
  substack: 'Substack',
  threads: 'Threads',
  tiktok: 'TikTok',
  twitter: 'X / Twitter',
  youtube: 'YouTube',
  other: 'Other',
}

/**
 * The record types a detail page exists for, and therefore the ones a UI module
 * can add a tab or a sidebar card to. Lived in `@kelpie/ui` until this package
 * gave it a home both the UI and the cloud repo can import.
 *
 * Narrower than the server's `RECORD_OBJECT_TYPES`, which is the list a
 * `record.*` event may carry. A Position, a Form, and a Handbook page are all
 * written and all publish events, but none of them has a detail page for a
 * module to hang anything off.
 */
export const EXTENSIBLE_RECORD_TYPES = [
  'person',
  'company',
  'deal',
  'opportunity',
  'partnership',
  'raise',
  'role',
  'candidate',
] as const

export type ExtensibleRecordType = (typeof EXTENSIBLE_RECORD_TYPES)[number]

/**
 * The record types a note, activity, decision, or plan item attaches to.
 *
 * Not the same list as `EXTENSIBLE_RECORD_TYPES`: a Role is a detail page a UI
 * module can extend, but nothing attaches a note to it. Interview notes go on
 * the Candidate, which is the person-and-role link.
 */
export const RECORD_TARGET_TYPES = [
  'person',
  'company',
  'deal',
  'opportunity',
  'partnership',
  'raise',
  'candidate',
] as const

export type RecordTargetType = (typeof RECORD_TARGET_TYPES)[number]

/** Whether a Role is still being hired for. */
export const ROLE_STATUSES = ['open', 'closed'] as const

export type RoleStatus = (typeof ROLE_STATUSES)[number]

export const ROLE_STATUS_LABELS: Readonly<Record<RoleStatus, string>> = {
  open: 'Open',
  closed: 'Closed',
}

/**
 * Where a Candidate stands with the Role they are attached to.
 *
 * This is the Person↔Role link's state, never a column on Person: the same
 * person can be in process for one role and in the nurture pile for another.
 */
export const CANDIDATE_STATUSES = [
  'in_process',
  'nurture',
  'hired',
  'passed',
  'withdrawn',
] as const

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

export const CANDIDATE_STATUS_LABELS: Readonly<Record<CandidateStatus, string>> = {
  in_process: 'In process',
  nurture: 'Nurture',
  hired: 'Hired',
  passed: 'Passed',
  withdrawn: 'Withdrawn',
}

/** The one status that carries an interview stage. Every other status clears it. */
export const IN_PROCESS: CandidateStatus = 'in_process'

/**
 * How far through interviewing a candidate is, in order. Meaningful only while
 * the candidate is in process, which is why `interview_stage` is nullable.
 */
export const INTERVIEW_STAGES = ['sourced', 'screen', 'interview', 'offer'] as const

export type InterviewStage = (typeof INTERVIEW_STAGES)[number]

export const INTERVIEW_STAGE_LABELS: Readonly<Record<InterviewStage, string>> = {
  sourced: 'Sourced',
  screen: 'Screen',
  interview: 'Interview',
  offer: 'Offer',
}

/** Where a candidate enters the process when no stage is named. */
export const FIRST_INTERVIEW_STAGE: InterviewStage = INTERVIEW_STAGES[0]

/**
 * The four pipelines whose board columns live in `pipeline_stages`. A Deal moves
 * through `deal` stages and so on; the kinds are fixed even though the stages
 * within each are workspace-configurable.
 */
export const PIPELINE_KINDS = ['deal', 'opportunity', 'raise', 'partnership'] as const

export type PipelineKind = (typeof PIPELINE_KINDS)[number]

/** Display names for `PIPELINE_KINDS`. "Fundraising" is what the nav calls a Raise. */
export const PIPELINE_KIND_LABELS: Readonly<Record<PipelineKind, string>> = {
  deal: 'Deal',
  opportunity: 'Opportunity',
  raise: 'Fundraising',
  partnership: 'Partnership',
}

/**
 * How far along a plan item is. Stored, never derived: whether something is
 * overdue is a question about its date, and whether it is finished is a question
 * about this column, and conflating the two would make a late-but-done item
 * shout for attention forever.
 */
export const PLAN_ITEM_STATUSES = ['todo', 'in_progress', 'done'] as const

export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number]

export const PLAN_ITEM_STATUS_LABELS: Readonly<Record<PlanItemStatus, string>> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
}

/** The statuses that still need doing. `plan.completed` fires on leaving this set. */
export const OPEN_PLAN_ITEM_STATUSES = ['todo', 'in_progress'] as const

/**
 * What an activity says happened. `created`, `updated`, `stage_changed`,
 * `note_added`, `linked` and `unlinked` are emitted by the server; `email`,
 * `call` and `meeting` are logged history an integration or an agent supplies.
 *
 * `unlinked` is only filed when a link is deleted through its own route. A link
 * that dies with either of its ends never reaches a service, so the timeline
 * that survives keeps the `linked` row without a counterpart. That row is
 * history rather than a claim about the present, so it stays true either way.
 */
export const ACTIVITY_KINDS = [
  'created',
  'updated',
  'stage_changed',
  'note_added',
  'email',
  'call',
  'meeting',
  'linked',
  'unlinked',
] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const

export type MemberRole = (typeof MEMBER_ROLES)[number]

/**
 * Roles an invitation may offer. Ownership is created with the workspace or
 * transferred between members; it is never invited, and the `invites.role` check
 * constraint says the same.
 */
export const INVITABLE_ROLES = ['admin', 'member'] as const

export type InvitableRole = (typeof INVITABLE_ROLES)[number]

/** What a pending invitation is called once its `expires_at` has passed. */
export const INVITE_STATUSES = ['pending', 'expired'] as const

export type InviteStatus = (typeof INVITE_STATUSES)[number]

/**
 * Light, dark, or whatever the operating system says.
 *
 * `system` is a stored answer rather than the absence of one: a reader who has
 * chosen to follow the machine has expressed a preference, and it has to survive
 * a move to a browser whose machine currently says something else.
 */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]

/** A paused form still exists and still renders; its submit answers 409 (`forms.md`). */
export const FORM_STATUSES = ['active', 'paused'] as const

export type FormStatus = (typeof FORM_STATUSES)[number]

/**
 * What a field renders as in the embed. Deliberately short: `forms.md` puts file
 * uploads, multi-page forms and branching out of scope, and every type here is
 * one `<input>`, `<textarea>` or `<select>`.
 */
export const FORM_FIELD_TYPES = ['text', 'email', 'textarea', 'select'] as const

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

/**
 * Where a field's answer lands on submit.
 *
 * `position.title` rather than a person field, because a job title belongs to the
 * Person↔Company link and nowhere else. `submission` stores the answer without
 * writing any CRM record, which is what a free-text "How can we help?" wants.
 */
export const FORM_FIELD_MAP_TARGETS = [
  'person.name',
  'person.email',
  'company.name',
  'company.domain',
  'position.title',
  'deal.name',
  'submission',
] as const

export type FormFieldMapTarget = (typeof FORM_FIELD_MAP_TARGETS)[number]

export const FORM_FIELD_MAP_TARGET_LABELS: Readonly<Record<FormFieldMapTarget, string>> = {
  'person.name': 'Person · name',
  'person.email': 'Person · email',
  'company.name': 'Company · name',
  'company.domain': 'Company · domain',
  'position.title': 'Position · title',
  'deal.name': 'Deal · name',
  submission: 'Submission only',
}

/** The one mapping a form cannot process without, and may carry at most once. */
export const PERSON_EMAIL_TARGET: FormFieldMapTarget = 'person.email'

/**
 * How a select option's stored key should be read back.
 *
 * The answer map is `fieldId → string` on the wire either way; this says what
 * the string means, so a consumer knows `"true"` was a checkbox and not a word.
 */
export const FORM_OPTION_VALUE_TYPES = ['string', 'number', 'boolean'] as const

export type FormOptionValueType = (typeof FORM_OPTION_VALUE_TYPES)[number]

/**
 * The domain events a webhook can subscribe to.
 *
 * A subset of the server's event catalog on purpose: the ticket's minimum
 * viable set, and the events whose payloads describe something a receiver
 * outside Kelpie can act on. The rest of the catalog (`stage.changed`,
 * `note.added`, membership and workspace events) is not deliverable yet, so it
 * is not offered rather than accepted and silently never sent.
 */
export const WEBHOOK_EVENTS = [
  'record.created',
  'record.updated',
  'record.deleted',
  'form.submitted',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/**
 * `failing` is the delivery engine's, not the customer's: it means the last
 * delivery exhausted its attempts. `paused` is the customer's, and stops
 * delivery entirely. A failing webhook keeps being tried, which is what lets it
 * return to `active` on its own once the endpoint recovers.
 */
export const WEBHOOK_STATUSES = ['active', 'failing', 'paused'] as const

export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number]

/** What a `PATCH` may set. `failing` is a report on the endpoint, not a request. */
export const WEBHOOK_SETTABLE_STATUSES = ['active', 'paused'] as const

export type WebhookSettableStatus = (typeof WEBHOOK_SETTABLE_STATUSES)[number]

/** A delivery is only logged once it has settled, so there is no pending value. */
export const WEBHOOK_DELIVERY_STATUSES = ['success', 'failed'] as const

export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number]

export const WEBHOOK_STATUS_LABELS: Readonly<Record<WebhookStatus, string>> = {
  active: 'Active',
  failing: 'Failing',
  paused: 'Paused',
}
