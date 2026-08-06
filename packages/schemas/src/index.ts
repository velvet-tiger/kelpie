/**
 * `@kelpie/schemas` — the wire contract for `/v1`, as Zod schemas.
 *
 * Roadmap decision 8: the UI decodes API responses with Zod, and a schema's
 * `.parse` is already the `Decoder<T>` the API client takes. These schemas live
 * in their own package because `@kelpie/ui` must not import `@kelpie/server`;
 * that would put Drizzle, postgres.js, and Node built-ins in the browser bundle.
 * The dependency list here is Zod and nothing else, which is also what makes the
 * package usable from the cloud repo.
 *
 * Each resource module holds three things: the record the UI works with, a
 * schema that parses the `snake_case` response into it, and a function that
 * builds a request body back out of it.
 */

export {
  ACCOUNT_TYPES,
  ACTIVITY_KINDS,
  CANDIDATE_STATUS_LABELS,
  CANDIDATE_STATUSES,
  COMPANY_STAGES,
  EXTENSIBLE_RECORD_TYPES,
  FIRST_INTERVIEW_STAGE,
  FORM_FIELD_MAP_TARGET_LABELS,
  FORM_FIELD_MAP_TARGETS,
  FORM_FIELD_TYPES,
  FORM_OPTION_VALUE_TYPES,
  FORM_STATUSES,
  ICP_FITS,
  IN_PROCESS,
  INFLUENCE_LEVELS,
  INTERVIEW_STAGE_LABELS,
  INTERVIEW_STAGES,
  INVITABLE_ROLES,
  INVITE_STATUSES,
  MEMBER_ROLES,
  OPEN_PLAN_ITEM_STATUSES,
  PERSON_EMAIL_TARGET,
  PIPELINE_KIND_LABELS,
  PIPELINE_KINDS,
  PLAN_ITEM_STATUS_LABELS,
  PLAN_ITEM_STATUSES,
  PREFERRED_CHANNELS,
  RECORD_TARGET_TYPES,
  RELATIONSHIP_LEVELS,
  ROLE_STATUS_LABELS,
  ROLE_STATUSES,
  SIZE_BANDS,
  SOCIAL_NETWORK_IDS,
  SOCIAL_NETWORK_LABELS,
  THEME_PREFERENCES,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENTS,
  WEBHOOK_SETTABLE_STATUSES,
  WEBHOOK_STATUS_LABELS,
  WEBHOOK_STATUSES,
} from './values.ts'
export type {
  AccountType,
  ActivityKind,
  CandidateStatus,
  CompanyStage,
  ExtensibleRecordType,
  FormFieldMapTarget,
  FormFieldType,
  FormOptionValueType,
  FormStatus,
  IcpFit,
  Influence,
  InterviewStage,
  InvitableRole,
  InviteStatus,
  MemberRole,
  PipelineKind,
  PlanItemStatus,
  PreferredChannel,
  RecordTargetType,
  Relationship,
  RoleStatus,
  SizeBand,
  SocialNetworkId,
  ThemePreference,
  WebhookDeliveryStatus,
  WebhookEvent,
  WebhookSettableStatus,
  WebhookStatus,
} from './values.ts'

export { definedFields, idSchema, nullableTimestampSchema, timestampSchema } from './wire.ts'
export type { RecordTimestamps } from './wire.ts'

export { personBody, personSchema } from './person.ts'
export type { Person, PersonInput, SocialProfile } from './person.ts'

export { companyBody, companySchema } from './company.ts'
export type { Company, CompanyInput } from './company.ts'

export { createPositionBody, positionSchema, updatePositionBody } from './position.ts'
export type { CreatePositionInput, Position } from './position.ts'

export { dealBody, dealSchema } from './deal.ts'
export type { Deal, DealInput } from './deal.ts'

export { opportunityBody, opportunitySchema } from './opportunity.ts'
export type { Opportunity, OpportunityInput } from './opportunity.ts'

export { partnershipBody, partnershipSchema } from './partnership.ts'
export type { Partnership, PartnershipInput } from './partnership.ts'

export { raiseBody, raiseSchema } from './raise.ts'
export type { Raise, RaiseInput } from './raise.ts'

export { roleBody, roleSchema } from './role.ts'
export type { Role, RoleInput } from './role.ts'

export { candidateBody, candidateSchema, createCandidateBody } from './candidate.ts'
export type { Candidate, CandidateInput, CreateCandidateInput } from './candidate.ts'

export {
  createPipelineStageBody,
  pipelineStageSchema,
  updatePipelineStageBody,
} from './pipelineStage.ts'
export type {
  CreatePipelineStageInput,
  PipelineStage,
  UpdatePipelineStageInput,
} from './pipelineStage.ts'

export { createNoteBody, noteBody, noteSchema } from './note.ts'
export type { CreateNoteInput, Note, NoteInput } from './note.ts'

export { createPlanItemBody, planItemBody, planItemSchema } from './planItem.ts'
export type { CreatePlanItemInput, PlanItem, PlanItemInput } from './planItem.ts'

export { createDecisionBody, decisionBody, decisionSchema } from './decision.ts'
export type { CreateDecisionInput, Decision, DecisionInput } from './decision.ts'

export {
  MAX_HANDBOOK_DEPTH,
  createHandbookPageBody,
  handbookPageBody,
  handbookPageSchema,
} from './handbookPage.ts'
export type {
  CreateHandbookPageInput,
  HandbookPage,
  HandbookPageInput,
} from './handbookPage.ts'

export { createFormBody, formBody, formSchema } from './form.ts'
export type {
  CreateFormInput,
  Form,
  FormField,
  FormFieldInput,
  FormFieldOption,
  FormFieldOptionInput,
  FormInput,
} from './form.ts'

export { formSubmissionSchema, formSubmitResultSchema } from './formSubmission.ts'
export type { FormSubmission, FormSubmitResult } from './formSubmission.ts'

export {
  CONFLICT_MODE_LABELS,
  IMPORT_CONFLICT_MODES,
  IMPORT_JOB_STATUSES,
  IMPORT_OBJECTS,
  IMPORT_PREVIEW_ROWS,
  IMPORT_REPORTED_ERRORS,
  IMPORT_ROW_ACTIONS,
  IMPORT_SOURCES,
  LIST_COLUMNS,
  MATCH_KEYS,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  OBJECT_COLUMNS,
  OBJECT_LABELS,
  SOURCE_LABELS,
  SYNC_IMPORT_ROWS,
  defaultMatchKeyId,
  findMatchKey,
  importJobSchema,
  isImportJobSettled,
  requiredColumns,
} from './importExport.ts'
export type {
  CsvColumn,
  ImportColumnMap,
  ImportConflictMode,
  ImportCounts,
  ImportJob,
  ImportJobStatus,
  ImportObject,
  ImportPreviewRow,
  ImportRowAction,
  ImportRowError,
  ImportSource,
  MatchKeyOption,
  SettledRowAction,
} from './importExport.ts'

export {
  WEBHOOK_SECRET_OVERLAP_HOURS,
  createWebhookBody,
  createdWebhookSchema,
  rotateWebhookSecretBody,
  webhookBody,
  webhookDeliverySchema,
  webhookSchema,
} from './webhook.ts'
export type {
  CreateWebhookInput,
  CreatedWebhook,
  RotateWebhookSecretInput,
  Webhook,
  WebhookDelivery,
  WebhookInput,
} from './webhook.ts'

export { activitySchema } from './activity.ts'
export type { Activity } from './activity.ts'

export { memberSchema, updateMemberRoleBody } from './member.ts'
export type { Member, UpdateMemberRoleInput } from './member.ts'

export { createInviteBody, inviteSchema, resendInviteBody } from './invite.ts'
export type { CreateInviteInput, Invite, ResendInviteInput } from './invite.ts'

export {
  confirmPasswordResetBody,
  createWorkspaceBody,
  logInBody,
  requestPasswordResetBody,
  sessionSchema,
  signUpBody,
  signedInAccountSchema,
  updateWorkspaceBody,
  workspaceSchema,
} from './session.ts'
export type {
  ConfirmPasswordResetInput,
  CreateWorkspaceInput,
  LogInInput,
  RequestPasswordResetInput,
  Session,
  SignUpInput,
  SignedInAccount,
  UpdateWorkspaceInput,
  Workspace,
} from './session.ts'

export {
  MINIMUM_PASSWORD_LENGTH,
  accountPreferencesSchema,
  accountSchema,
  accountSessionSchema,
  changePasswordBody,
  updateAccountBody,
  updateAccountPreferencesBody,
} from './account.ts'
export type {
  Account,
  AccountPreferences,
  AccountSession,
  ChangePasswordInput,
  UpdateAccountInput,
  UpdateAccountPreferencesInput,
} from './account.ts'
