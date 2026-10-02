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
  'enquiry',
  'event',
  'role',
  'candidate',
  'attendance',
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
  'enquiry',
  'candidate',
  'event',
  'attendance',
] as const

export type RecordTargetType = (typeof RECORD_TARGET_TYPES)[number]

/** Human labels for `RECORD_TARGET_TYPES`. Used by any picker that names a type. */
export const RECORD_TARGET_TYPE_LABELS: Readonly<Record<RecordTargetType, string>> = {
  person: 'Person',
  company: 'Company',
  deal: 'Deal',
  opportunity: 'Opportunity',
  partnership: 'Partnership',
  raise: 'Raise',
  enquiry: 'Enquiry',
  candidate: 'Candidate',
  event: 'Event',
  attendance: 'Attendance',
}

/**
 * What `GET /v1/search` looks through, and the order its groups come back in.
 *
 * Handbook leads because a question phrased in words rather than names is usually
 * a question the handbook answers. The rest follow the sidebar.
 *
 * Neither of the lists above fits. `RECORD_OBJECT_TYPES` on the server has no
 * Decision and does have Position, Candidate and Form: a Position is reachable
 * only as the person holding it, and nobody searches for a Candidate by name
 * without finding the Person first.
 */
export const SEARCH_COLLECTIONS = [
  'handbook_page',
  'person',
  'role',
  'company',
  'enquiry',
  'deal',
  'opportunity',
  'raise',
  'partnership',
  'event',
  'decision',
  'note',
  'plan_item',
  'list',
  'form',
] as const

export type SearchCollection = (typeof SEARCH_COLLECTIONS)[number]

/**
 * The record types that carry a `tags` array, and what `GET /v1/tags?target_type=`
 * accepts. A Form's `person_tags` and `company_tags` count toward `person` and
 * `company`: they are tags the form will set, not tags a form carries.
 */
export const TAG_TARGET_TYPES = [
  'person',
  'company',
  'enquiry',
  'deal',
  'opportunity',
  'raise',
  'partnership',
  'event',
] as const

export type TagTargetType = (typeof TAG_TARGET_TYPES)[number]

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
 * The five pipelines whose board columns live in `pipeline_stages`. A Deal moves
 * through `deal` stages and so on; the kinds are fixed even though the stages
 * within each are workspace-configurable.
 */
export const PIPELINE_KINDS = [
  'enquiry',
  'deal',
  'opportunity',
  'raise',
  'partnership',
] as const

export type PipelineKind = (typeof PIPELINE_KINDS)[number]

/** Display names for `PIPELINE_KINDS`. "Fundraising" is what the nav calls a Raise. */
export const PIPELINE_KIND_LABELS: Readonly<Record<PipelineKind, string>> = {
  enquiry: 'Enquiry',
  deal: 'Deal',
  opportunity: 'Opportunity',
  raise: 'Fundraising',
  partnership: 'Partnership',
}

/**
 * What a Plan item may attach to: the five pipelines plus Event.
 *
 * Event is a calendar object, not a pipeline, but prep work ("send reminder",
 * "record the session") still needs a dated action on the Event itself.
 */
export const PLAN_ITEM_TARGET_TYPES = [
  'enquiry',
  'deal',
  'opportunity',
  'raise',
  'partnership',
  'event',
] as const

export type PlanItemTargetType = (typeof PLAN_ITEM_TARGET_TYPES)[number]

export const PLAN_ITEM_TARGET_TYPE_LABELS: Readonly<Record<PlanItemTargetType, string>> = {
  enquiry: 'Enquiry',
  deal: 'Deal',
  opportunity: 'Opportunity',
  raise: 'Fundraising',
  partnership: 'Partnership',
  event: 'Event',
}

/**
 * Form attach targets: pipeline records (person_links) plus Event (Attendance).
 */
export const FORM_ATTACH_TARGET_TYPES = [
  'enquiry',
  'deal',
  'opportunity',
  'raise',
  'partnership',
  'event',
] as const

export type FormAttachTargetType = (typeof FORM_ATTACH_TARGET_TYPES)[number]

/** Where an Event may point besides its own Attendances. */
export const EVENT_ASSOCIATION_TARGET_TYPES = [
  'person',
  'company',
  'deal',
  'opportunity',
  'partnership',
  'raise',
  'enquiry',
  'role',
  'candidate',
] as const

export type EventAssociationTargetType = (typeof EVENT_ASSOCIATION_TARGET_TYPES)[number]

export const EVENT_ASSOCIATION_TARGET_TYPE_LABELS: Readonly<
  Record<EventAssociationTargetType, string>
> = {
  person: 'Person',
  company: 'Company',
  deal: 'Deal',
  opportunity: 'Opportunity',
  partnership: 'Partnership',
  raise: 'Raise',
  enquiry: 'Enquiry',
  role: 'Role',
  candidate: 'Candidate',
}

export const EVENT_FORMATS = ['in_person', 'virtual', 'hybrid'] as const

export type EventFormat = (typeof EVENT_FORMATS)[number]

export const EVENT_FORMAT_LABELS: Readonly<Record<EventFormat, string>> = {
  in_person: 'In person',
  virtual: 'Virtual',
  hybrid: 'Hybrid',
}

export const EVENT_STATUSES = ['draft', 'scheduled', 'cancelled'] as const

export type EventStatus = (typeof EVENT_STATUSES)[number]

export const EVENT_STATUS_LABELS: Readonly<Record<EventStatus, string>> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  cancelled: 'Cancelled',
}

export const ATTENDANCE_STATUSES = ['registered', 'attended', 'no_show', 'cancelled'] as const

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number]

export const ATTENDANCE_STATUS_LABELS: Readonly<Record<AttendanceStatus, string>> = {
  registered: 'Registered',
  attended: 'Attended',
  no_show: 'No-show',
  cancelled: 'Cancelled',
}

export const ATTENDANCE_SOURCES = ['manual', 'form'] as const

export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number]

export const ATTENDANCE_SOURCE_LABELS: Readonly<Record<AttendanceSource, string>> = {
  manual: 'Manual',
  form: 'Form',
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
 * A `workspace` key belongs to the workspace and needs the admin role to create
 * or revoke. A `personal` key belongs to one member and is theirs alone.
 */
export const API_KEY_KINDS = ['workspace', 'personal'] as const

export type ApiKeyKind = (typeof API_KEY_KINDS)[number]

/**
 * Light, dark, or whatever the operating system says.
 *
 * `system` is a stored answer rather than the absence of one: a reader who has
 * chosen to follow the machine has expressed a preference, and it has to survive
 * a move to a browser whose machine currently says something else.
 */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]

/** A paused form still exists and still renders; its submit answers 409. */
export const FORM_STATUSES = ['active', 'paused'] as const

/**
 * What a form slug may contain: letters, digits, `-` and `_`, 3 to 64 characters.
 * The slug sits in a URL path, so nothing here needs escaping.
 */
export const FORM_SLUG_PATTERN = /^[A-Za-z0-9_-]{3,64}$/

export type FormStatus = (typeof FORM_STATUSES)[number]

/**
 * What a field renders as in the embed. Deliberately short: file uploads,
 * multi-page forms and branching are out of scope, and every type here is
 * one `<input>`, `<textarea>` or `<select>`, or a set of checkboxes (`consent`
 * and `list`).
 */
export const FORM_FIELD_TYPES = [
  'text',
  'email',
  'textarea',
  'select',
  'consent',
  'notice',
  'list',
] as const

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

/**
 * The field types whose answer is stored as a boolean, not a string. A
 * `consent` field renders as a checkbox whose label carries the consent
 * statement; the answer records whether the visitor ticked it.
 */
export const FORM_BOOLEAN_FIELD_TYPES = ['consent'] as const

export type FormBooleanFieldType = (typeof FORM_BOOLEAN_FIELD_TYPES)[number]

/**
 * Where a field's answer lands on submit.
 *
 * `position.title` rather than a person field, because a job title belongs to the
 * Person↔Company link and nowhere else. `submission` stores the answer without
 * writing any CRM record, which is what a free-text "How can we help?" wants.
 *
 * A form asks for a name the way its author wants it asked: one `person.name`
 * box, or the `person.first_name` / `person.last_name` pair most sign-up forms
 * use. Mapping the pair and no `person.name` composes the display name from the
 * two, so neither arrangement makes a nameless person. `salutation` and `suffix`
 * are storable on a Person but are not offered here — a public form asking for
 * them is rare enough that the choice is not worth the room in this list.
 */
export const FORM_FIELD_MAP_TARGETS = [
  'person.name',
  'person.first_name',
  'person.last_name',
  'person.email',
  'person.phones',
  'person.consent',
  'company.name',
  'company.domain',
  'position.title',
  'enquiry.name',
  'deal.name',
  'opportunity.name',
  'partnership.name',
  'submission',
] as const

/** Any valid form map target string. See `formMapTargets.ts` for the full catalog. */
export type FormFieldMapTarget = string

export const FORM_FIELD_MAP_TARGET_LABELS: Readonly<
  Record<(typeof FORM_FIELD_MAP_TARGETS)[number], string>
> = {
  'person.name': 'Person · name',
  'person.first_name': 'Person · first name',
  'person.last_name': 'Person · last name',
  'person.email': 'Person · email',
  'person.phones': 'Person · phone',
  'person.consent': 'Person · consent',
  'company.name': 'Company · name',
  'company.domain': 'Company · domain',
  'position.title': 'Position · title',
  'enquiry.name': 'Enquiry · name',
  'deal.name': 'Deal · name',
  'opportunity.name': 'Opportunity · name',
  'partnership.name': 'Partnership · name',
  submission: 'Submission only',
}

/** The map target for a consent field. Repeats per purpose, unlike `person.email`. */
export const PERSON_CONSENT_TARGET: FormFieldMapTarget = 'person.consent'

/**
 * The map target for an "Add to list" field. Repeatable: each field offers its
 * own lists, one checkbox per list, and a ticked box adds the submitter (or the
 * resolved company, for a company list) to that list.
 */
export const FORM_LIST_TARGET: FormFieldMapTarget = 'lists'

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
 * Each post-submit action lands one of these on the submission's `action_log`.
 * `ok` = the action ran; `skipped` = its precondition was absent (a company
 * list on a submit that never resolved one); `error` = the savepoint rolled
 * back so the rest of the submit could continue.
 */
export const FORM_ACTION_STATUSES = ['ok', 'skipped', 'error'] as const

export type FormActionStatus = (typeof FORM_ACTION_STATUSES)[number]

/**
 * Where a submission stands. `spam` means the spam check caught it: the
 * answers are kept, and nothing was written to the CRM and no email was sent.
 * A person can release a `spam` submission, which runs the submit rules on the
 * stored answers and makes it `accepted`.
 */
export const FORM_SUBMISSION_STATUSES = ['accepted', 'spam'] as const

export type FormSubmissionStatus = (typeof FORM_SUBMISSION_STATUSES)[number]

/**
 * Why the spam check caught a submission.
 *
 * `honeypot`: the hidden field had a value. `token_missing`, `token_invalid`,
 * `token_expired`: the submit did not carry a token this deployment issued for
 * this form in the last day. `too_fast`: the submit arrived sooner after the
 * token than a person can fill a form in. `captcha_missing`, `captcha_failed`:
 * the deployment has a CAPTCHA provider and the answer was absent or refused.
 */
export const FORM_SPAM_REASONS = [
  'honeypot',
  'token_missing',
  'token_invalid',
  'token_expired',
  'too_fast',
  'captcha_missing',
  'captcha_failed',
] as const

export type FormSpamReason = (typeof FORM_SPAM_REASONS)[number]

export const FORM_SPAM_REASON_LABELS: Readonly<Record<FormSpamReason, string>> = {
  honeypot: 'A hidden field that people cannot see had a value',
  token_missing: 'The submit did not come from the Kelpie form',
  token_invalid: 'The submit carried a token that Kelpie did not issue for this form',
  token_expired: 'The form page was open for more than a day before the submit',
  too_fast: 'The submit arrived too quickly for a person to fill in the form',
  captcha_missing: 'The submit carried no CAPTCHA answer',
  captcha_failed: 'The CAPTCHA provider refused the answer',
}

/**
 * The two emails a form can send after a submit: a `notification` to people
 * the workspace names, and an `auto_reply` to the submitter.
 */
export const FORM_EMAIL_KINDS = ['notification', 'auto_reply'] as const

export type FormEmailKind = (typeof FORM_EMAIL_KINDS)[number]

/**
 * How a form names an email recipient: a workspace `member` (resolved to the
 * member's account email when the email is sent) or a free-text `address`.
 */
export const FORM_EMAIL_RECIPIENT_KINDS = ['member', 'address'] as const

export type FormEmailRecipientKind = (typeof FORM_EMAIL_RECIPIENT_KINDS)[number]

/** What happened to one message a form's email job tried to send. */
export const FORM_EMAIL_SEND_STATUSES = ['sent', 'skipped', 'error'] as const

export type FormEmailSendStatus = (typeof FORM_EMAIL_SEND_STATUSES)[number]

/** The most notification recipients one form can name. */
export const FORM_EMAIL_MAX_RECIPIENTS = 10

/** Longest email subject template, in characters. */
export const FORM_EMAIL_SUBJECT_MAX_LENGTH = 200

/** Longest email body template, in characters. */
export const FORM_EMAIL_BODY_MAX_LENGTH = 10_000

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

/**
 * What an agent task can point at: the seven attachable record types, plus
 * three surfaces that carry tasks without being note targets — a Role, a
 * Handbook page, and the workspace itself.
 */
export const AGENT_TASK_TARGET_TYPES = [
  'person',
  'company',
  'deal',
  'opportunity',
  'partnership',
  'raise',
  'enquiry',
  'event',
  'candidate',
  'role',
  'handbook',
  'workspace',
] as const

export type AgentTaskTargetType = (typeof AGENT_TASK_TARGET_TYPES)[number]

/** `primary` shows as a compact action; `overflow` lives under "More". */
export const AGENT_TASK_PLACEMENTS = ['primary', 'overflow'] as const

export type AgentTaskPlacement = (typeof AGENT_TASK_PLACEMENTS)[number]

/**
 * Where a run's dispatch stands. The lifecycle describes the POST to the
 * registered agent, not the agent's own work: Kelpie hands the prompt over and
 * records whether the handover landed. There is no callback for an agent to
 * report completion, so anything past the dispatch would be a guess.
 */
export const AGENT_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number]

export const AGENT_RUN_STATUS_LABELS: Readonly<Record<AgentRunStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
}

/**
 * The seven record types a workspace may attach custom field definitions to.
 *
 * The ones that already carry `tags` and agent-oriented fields on the record
 * itself. Role and Candidate are absent on purpose: hiring state hangs off the
 * Candidate link and a Role is a header rather than a rich record, so the demand
 * signal for custom fields on either has not landed. Kept separate from
 * `RECORD_TARGET_TYPES` and `EXTENSIBLE_RECORD_TYPES` so a later addition here
 * cannot silently widen either of those.
 */
export const CUSTOM_FIELD_OBJECT_TYPES = [
  'person',
  'company',
  'deal',
  'opportunity',
  'partnership',
  'raise',
  'enquiry',
  'event',
] as const

export type CustomFieldObjectType = (typeof CUSTOM_FIELD_OBJECT_TYPES)[number]

export const CUSTOM_FIELD_OBJECT_TYPE_LABELS: Readonly<Record<CustomFieldObjectType, string>> = {
  person: 'Person',
  company: 'Company',
  deal: 'Deal',
  opportunity: 'Opportunity',
  partnership: 'Partnership',
  raise: 'Raise',
  enquiry: 'Enquiry',
  event: 'Event',
}

/**
 * The nine editor types a custom field can carry.
 *
 * Deliberately distinct from `FORM_FIELD_TYPES`: a form asks a stranger for four
 * kinds of text over one submit; a custom field is a first-class attribute on a
 * record with numeric, date, boolean and currency answers. Sharing one list
 * would drag either surface toward the other's shape.
 *
 * `record_reference` is intentionally absent from v1 — it needs the polymorphic
 * existence check and delete-transaction cleanup that Phase 2 owns.
 */
export const CUSTOM_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'currency',
  'date',
  'checkbox',
  'select',
  'multi_select',
  'url',
] as const

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

export const CUSTOM_FIELD_TYPE_LABELS: Readonly<Record<CustomFieldType, string>> = {
  text: 'Text',
  long_text: 'Long text',
  number: 'Number',
  currency: 'Currency',
  date: 'Date',
  checkbox: 'Checkbox',
  select: 'Select',
  multi_select: 'Multi-select',
  url: 'URL',
}

/**
 * The custom-field types whose definition carries an `options` list. Every
 * other type stores its `options` as `[]` and any non-empty write is `422`.
 */
export const CUSTOM_FIELD_TYPES_WITH_OPTIONS = ['select', 'multi_select'] as const

export type CustomFieldTypeWithOptions = (typeof CUSTOM_FIELD_TYPES_WITH_OPTIONS)[number]

/**
 * The default a consent purpose starts with, and what a person without an
 * explicit `person_consents` row inherits for that purpose. `unknown` is the
 * safest default — silence about a person's wishes is not a grant.
 */
export const CONSENT_PURPOSE_STATUSES = ['unknown', 'granted', 'withdrawn'] as const

export type ConsentPurposeStatus = (typeof CONSENT_PURPOSE_STATUSES)[number]

export const CONSENT_PURPOSE_STATUS_LABELS: Readonly<Record<ConsentPurposeStatus, string>> = {
  unknown: 'Unknown',
  granted: 'Granted',
  withdrawn: 'Withdrawn',
}

/**
 * The explicit status on a `person_consents` row. `unknown` is deliberately
 * absent: no row is the unknown, so a stored row always carries a decision.
 */
export const CONSENT_STATUSES = ['granted', 'withdrawn'] as const

export type ConsentStatus = (typeof CONSENT_STATUSES)[number]

export const CONSENT_STATUS_LABELS: Readonly<Record<ConsentStatus, string>> = {
  granted: 'Granted',
  withdrawn: 'Withdrawn',
}

/**
 * Where a `person_consents` row came from. `form:<form_id>` and `list:<list_id>`
 * are prefixed so the origin is inspectable; `import` and `manual` need no id.
 */
export const CONSENT_SOURCE_KINDS = ['form', 'list', 'import', 'manual'] as const

export type ConsentSourceKind = (typeof CONSENT_SOURCE_KINDS)[number]
