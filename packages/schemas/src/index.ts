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
  COMPANY_STAGES,
  ICP_FITS,
  INFLUENCE_LEVELS,
  MEMBER_ROLES,
  OPEN_PLAN_ITEM_STATUSES,
  PIPELINE_KIND_LABELS,
  PIPELINE_KINDS,
  PLAN_ITEM_STATUS_LABELS,
  PLAN_ITEM_STATUSES,
  PREFERRED_CHANNELS,
  RECORD_OBJECT_TYPES,
  RECORD_TARGET_TYPES,
  RELATIONSHIP_LEVELS,
  SIZE_BANDS,
  SOCIAL_NETWORK_IDS,
  SOCIAL_NETWORK_LABELS,
} from './values.ts'
export type {
  AccountType,
  ActivityKind,
  CompanyStage,
  IcpFit,
  Influence,
  MemberRole,
  PipelineKind,
  PlanItemStatus,
  PreferredChannel,
  RecordObjectType,
  RecordTargetType,
  Relationship,
  SizeBand,
  SocialNetworkId,
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

export { activitySchema } from './activity.ts'
export type { Activity } from './activity.ts'

export { memberSchema } from './member.ts'
export type { Member } from './member.ts'

export {
  createWorkspaceBody,
  logInBody,
  sessionSchema,
  signedInAccountSchema,
  workspaceSchema,
} from './session.ts'
export type {
  Account,
  CreateWorkspaceInput,
  LogInInput,
  Session,
  SignedInAccount,
  Workspace,
} from './session.ts'
