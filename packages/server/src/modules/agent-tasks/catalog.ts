import type { AgentTaskDefinition, AgentTaskTargetType } from '@kelpie/schemas'

/**
 * The task catalog, ported from `mockups/src/data/agentTasks.ts`. Ids, labels,
 * instructions and handbook slugs match `agent-tasks.md` exactly.
 *
 * The catalog ships in code rather than in a table: a task is a prompt recipe
 * the product defines, not workspace data. `agent_runs.task_id` is therefore a
 * catalog string with no foreign key, so a recorded run outlives any catalog
 * edit.
 */

/** Embedded in every resolved prompt, per `agent-tasks.md`'s conventions. */
export const SHARED_WRITE_POLICY = `- Prefer appending a Note over inventing facts.
- Do not invent pricing, legal commitments, or security certifications not in the handbook or notes.
- Do not change pipeline stage unless the human confirmed or this task explicitly allows it with evidence.
- Respect open Decisions; do not contradict them.
- Job titles live on Position, never on Person.
- Prefer dated Plan items over a free-text next-step field.
- Draft outreach is draft-only; do not send email.`

function task(
  definition: Omit<AgentTaskDefinition, 'writePolicy'> & { readonly writePolicy?: string },
): AgentTaskDefinition {
  const { writePolicy, ...rest } = definition

  return { ...rest, writePolicy: writePolicy ?? SHARED_WRITE_POLICY }
}

export const AGENT_TASK_DEFINITIONS: readonly AgentTaskDefinition[] = [
  // Person
  task({
    id: 'person.enrich',
    label: 'Enrich profile',
    description: 'Fill summary, channel, tags, socials, timezone; propose Positions with titles.',
    targetTypes: ['person'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Research this person using public sources and existing CRM context.
Update agent fields: summary, preferredChannel, relationship, tags, timezone, socialProfiles when evidence supports them.
Propose Positions (person↔company + title) for employers you can verify. Never put title on Person.`,
  }),
  task({
    id: 'person.refresh_summary',
    label: 'Refresh relationship summary',
    description: 'Rebuild summary from notes and linked pipeline.',
    targetTypes: ['person'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Rewrite the Person summary from pinned notes, recent activities, and linked deals / partnerships / opportunities.
Keep it short enough for an agent to reuse in follow-ups.`,
  }),
  task({
    id: 'person.suggest_influence',
    label: 'Suggest influence',
    description: 'Infer champion / DM / blocker; low confidence → note.',
    targetTypes: ['person'],
    placement: 'primary',
    handbookSlugs: ['how-we-sell', 'agent-faq'],
    instructions: `Infer influence (champion, decision_maker, influencer, blocker, end_user) from deal activity and notes.
If confidence is low, append a Note with the rationale instead of overwriting influence.`,
  }),
  task({
    id: 'person.draft_outreach',
    label: 'Draft outreach',
    description: 'Channel-aware draft matching Voice; no send.',
    targetTypes: ['person'],
    placement: 'primary',
    handbookSlugs: ['voice-and-tone', 'how-we-sell', 'agent-faq'],
    instructions: `Draft a short outreach message for this Person's preferredChannel.
Match Voice and tone. Reference open Plans on linked deals when relevant.
Save the draft as a Note unless the human asks otherwise. Do not send.`,
  }),
  task({
    id: 'person.meeting_brief',
    label: 'Meeting brief',
    description: 'Read-only prep: warmth, Plans, pinned notes, Decisions.',
    targetTypes: ['person'],
    placement: 'primary',
    handbookSlugs: ['voice-and-tone', 'agent-faq'],
    instructions: `Produce a read-only meeting brief: who they are, relationship warmth, open Plans on linked records, pinned notes, open Decisions.
Do not mutate CRM fields unless asked to save the brief as a Note.`,
  }),
  task({
    id: 'person.find_company_links',
    label: 'Find company links',
    description: 'Propose Positions at known companies.',
    targetTypes: ['person'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Suggest Positions linking this Person to Companies already in the workspace (or clearly identifiable new companies).
Each suggestion needs a title. Create Positions only when evidence is strong; otherwise list proposals in a Note.`,
  }),
  task({
    id: 'person.distill_notes',
    label: 'Distill notes',
    description: 'Compress noise; pin high-signal notes.',
    targetTypes: ['person'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Review notes on this Person. Pin high-signal items. Optionally append one distilled Note and refresh the summary if it is stale.`,
  }),
  task({
    id: 'person.capture_decision',
    label: 'Capture decision',
    description: 'Turn a commitment into a Decision.',
    targetTypes: ['person'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `From recent notes or the human's instruction, create a Decision linked to this Person (body, rationale, owner, optional due date).`,
  }),
  task({
    id: 'person.log_transcript',
    label: 'Log transcript',
    description: 'Parse pasted call notes into note / fields / Plans.',
    targetTypes: ['person'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `The human will paste a call transcript or notes after this prompt.
Append a Note, update summary only when clearly supported, propose Plan items on linked pipeline records, and extract Decisions when commitments appear.`,
  }),

  // Company
  task({
    id: 'company.enrich',
    label: 'Enrich company',
    description: 'Research into description, stage, size, stack, tags, summary.',
    targetTypes: ['company'],
    placement: 'primary',
    handbookSlugs: ['ideal-customer-profile', 'agent-faq'],
    instructions: `Research this Company. Update description, stage, sizeBand, techStack, website/linkedin when evidenced, tags, and summary.
Append a Note listing sources. Prefer notes over guesses for uncertain facts.`,
  }),
  task({
    id: 'company.score_icp',
    label: 'Score ICP fit',
    description: 'Set icpFit against handbook ICP + rationale note.',
    targetTypes: ['company'],
    placement: 'primary',
    handbookSlugs: ['ideal-customer-profile', 'agent-faq'],
    instructions: `Score icpFit (high | medium | low | unknown) against the Ideal customer profile handbook page.
Update the field and append a short rationale Note.`,
  }),
  task({
    id: 'company.refresh_summary',
    label: 'Refresh account summary',
    description: 'Roll up deals, partnerships, raises, key people.',
    targetTypes: ['company'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Rewrite the Company summary from open deals, partnerships, raises, and key Positions/People.`,
  }),
  task({
    id: 'company.map_org',
    label: 'Map org',
    description: 'Suggest People / Positions to add.',
    targetTypes: ['company'],
    placement: 'primary',
    handbookSlugs: ['how-we-sell', 'agent-faq'],
    instructions: `Map the buying / partnering org: suggest People and Positions (with titles) missing from this Company.
Create records only with strong evidence; otherwise list gaps in a Note.`,
  }),
  task({
    id: 'company.account_brief',
    label: 'Account brief',
    description: 'Read-only cross-pipeline brief.',
    targetTypes: ['company'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Produce a read-only account brief across related deals, opportunities, partnerships, and raises.
Optionally save as a pinned Note.`,
  }),
  task({
    id: 'company.suggest_account_type',
    label: 'Suggest account type',
    description: 'prospect / customer / partner / investor from links.',
    targetTypes: ['company'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Suggest accountType from linked objects and notes. Update only with clear evidence; otherwise Note.`,
  }),
  task({
    id: 'company.distill_notes',
    label: 'Distill notes',
    description: 'Pin high-signal notes.',
    targetTypes: ['company'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Review notes on this Company. Pin high-signal items. Optionally refresh summary.`,
  }),
  task({
    id: 'company.capture_decision',
    label: 'Capture decision',
    description: 'Log a Decision on the company.',
    targetTypes: ['company'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Create a Decision linked to this Company from recent commitments or the human's instruction.`,
  }),

  // Deal
  task({
    id: 'deal.propose_plan',
    label: 'Propose Plan',
    description: 'Dated Plan items aligned with How we sell.',
    targetTypes: ['deal'],
    placement: 'primary',
    handbookSlugs: ['how-we-sell', 'agent-faq'],
    instructions: `Propose dated Plan items for this Deal (title, date, owner when clear, status todo).
Align with How we sell. Replace vague next steps with concrete Plan items. Do not invent stage changes.`,
  }),
  task({
    id: 'deal.refresh_summary',
    label: 'Refresh deal summary',
    description: 'Rewrite summary from evidence.',
    targetTypes: ['deal'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Rewrite the Deal summary from notes, stage, linked people, company, whyWin, and risks.`,
  }),
  task({
    id: 'deal.update_win_thesis',
    label: 'Update win thesis',
    description: 'Refresh whyWin, risks, competitors.',
    targetTypes: ['deal'],
    placement: 'primary',
    handbookSlugs: ['competitive-landscape', 'how-we-sell', 'agent-faq'],
    instructions: `Update whyWin, risks, and competitors from notes and handbook Competitive landscape.
Append a Note if evidence conflicts.`,
  }),
  task({
    id: 'deal.stakeholder_map',
    label: 'Stakeholder map',
    description: 'Missing champions / DMs vs linked People.',
    targetTypes: ['deal'],
    placement: 'primary',
    handbookSlugs: ['how-we-sell', 'agent-faq'],
    instructions: `Compare linked People and their influence to a healthy buying committee.
Suggest People to link or enrich. Prefer one strong champion over three lukewarm contacts.`,
  }),
  task({
    id: 'deal.meeting_brief',
    label: 'Meeting brief',
    description: 'Prep for call / demo.',
    targetTypes: ['deal'],
    placement: 'primary',
    handbookSlugs: ['voice-and-tone', 'product', 'agent-faq'],
    instructions: `Produce a meeting/demo brief: company, people, open Plans, pinned notes, open Decisions, win thesis.
Optionally save as a Note.`,
  }),
  task({
    id: 'deal.draft_follow_up',
    label: 'Draft follow-up',
    description: 'Post-call email draft + optional note.',
    targetTypes: ['deal'],
    placement: 'primary',
    handbookSlugs: ['voice-and-tone', 'how-we-sell', 'agent-faq'],
    instructions: `Draft a follow-up email in Voice. Reference open Plan items. Save draft as a Note. Do not send.`,
  }),
  task({
    id: 'deal.stage_sanity',
    label: 'Stage sanity check',
    description: 'Flag stage vs evidence; ask before moving.',
    targetTypes: ['deal'],
    placement: 'overflow',
    handbookSlugs: ['how-we-sell', 'agent-faq'],
    instructions: `Compare current stage to notes and Plans. If they disagree, explain and ask the human before changing stage.`,
  }),
  task({
    id: 'deal.competitive_brief',
    label: 'Competitive brief',
    description: 'Handbook competitive + deal competitors.',
    targetTypes: ['deal'],
    placement: 'overflow',
    handbookSlugs: ['competitive-landscape', 'agent-faq'],
    instructions: `Write a short competitive brief using handbook Competitive landscape and this Deal's competitors field.
Optionally save as a Note.`,
  }),
  task({
    id: 'deal.distill_notes',
    label: 'Distill notes',
    description: 'Pin high-signal notes.',
    targetTypes: ['deal'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Review notes on this Deal. Pin high-signal items. Optionally refresh summary.`,
  }),
  task({
    id: 'deal.capture_decision',
    label: 'Capture decision',
    description: 'Log a Decision on the deal.',
    targetTypes: ['deal'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Create a Decision linked to this Deal.`,
  }),
  task({
    id: 'deal.log_transcript',
    label: 'Log transcript',
    description: 'Parse call notes into CRM updates.',
    targetTypes: ['deal'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `The human will paste a call transcript after this prompt.
Append a Note, propose Plan items, update summary/whyWin/risks only with clear evidence, extract Decisions.`,
  }),

  // Opportunity
  task({
    id: 'opportunity.propose_plan',
    label: 'Propose Plan',
    description: 'Deadlines, demo prep, follow-ups as Plan items.',
    targetTypes: ['opportunity'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Propose dated Plan items for this Opportunity (applications, demos, follow-ups).`,
  }),
  task({
    id: 'opportunity.refresh_summary',
    label: 'Refresh summary',
    description: 'Rewrite summary from notes and stage.',
    targetTypes: ['opportunity'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Rewrite the Opportunity summary from kind, stage, notes, and linked company.`,
  }),
  task({
    id: 'opportunity.fit_check',
    label: 'Eligibility fit check',
    description: 'Fit vs handbook + opportunity notes.',
    targetTypes: ['opportunity'],
    placement: 'primary',
    handbookSlugs: ['ideal-customer-profile', 'product', 'agent-faq'],
    instructions: `Assess eligibility / strategic fit using handbook and notes on this Opportunity.
Append a Note with go / no-go rationale. Do not invent requirements not in notes.`,
  }),
  task({
    id: 'opportunity.draft_application',
    label: 'Draft application',
    description: 'Narrative from Product + Voice.',
    targetTypes: ['opportunity'],
    placement: 'primary',
    handbookSlugs: ['product', 'voice-and-tone', 'about-us', 'agent-faq'],
    instructions: `Draft application or pitch narrative from Product, Voice, and About us.
Save as a Note on the Opportunity. Do not invent metrics not in the handbook or CRM.`,
  }),
  task({
    id: 'opportunity.gap_analysis',
    label: 'Gap analysis',
    description: 'What’s missing before submit.',
    targetTypes: ['opportunity'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `List gaps before submit (people, materials, Plan items). Propose Plan items to close gaps.`,
  }),
  task({
    id: 'opportunity.meeting_brief',
    label: 'Meeting brief',
    description: 'Interview / demo prep.',
    targetTypes: ['opportunity'],
    placement: 'primary',
    handbookSlugs: ['voice-and-tone', 'product', 'agent-faq'],
    instructions: `Produce an interview/demo brief for this Opportunity. Optionally save as a Note.`,
  }),
  task({
    id: 'opportunity.distill_notes',
    label: 'Distill notes',
    description: 'Pin high-signal notes.',
    targetTypes: ['opportunity'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Review notes. Pin high-signal items. Optionally refresh summary.`,
  }),
  task({
    id: 'opportunity.capture_decision',
    label: 'Capture decision',
    description: 'Log a Decision.',
    targetTypes: ['opportunity'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Create a Decision linked to this Opportunity.`,
  }),
  task({
    id: 'opportunity.log_transcript',
    label: 'Log transcript',
    description: 'Parse notes into updates.',
    targetTypes: ['opportunity'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `The human will paste notes after this prompt. Append a Note; propose Plan items; extract Decisions.`,
  }),

  // Partnership
  task({
    id: 'partnership.propose_plan',
    label: 'Propose Plan',
    description: 'Touchpoints with dates.',
    targetTypes: ['partnership'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Propose dated Plan items aligned with nextTouchpoint, goals, and successLooksLike.`,
  }),
  task({
    id: 'partnership.refresh_summary',
    label: 'Refresh partnership summary',
    description: 'Status of the two-way relationship.',
    targetTypes: ['partnership'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Rewrite the Partnership summary from status, goals, key people, and notes.`,
  }),
  task({
    id: 'partnership.sharpen_goals',
    label: 'Sharpen goals',
    description: 'Tighten goals + successLooksLike.',
    targetTypes: ['partnership'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Tighten goals and successLooksLike from notes. No favour ledger — use Notes/Decisions for commitments.`,
  }),
  task({
    id: 'partnership.health_check',
    label: 'Health check',
    description: 'Overdue touchpoint, paused status, missing people.',
    targetTypes: ['partnership'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Assess health: nextTouchpoint, status, key people, open Plans. Propose Plan items or a check-in draft as a Note.`,
  }),
  task({
    id: 'partnership.draft_check_in',
    label: 'Draft check-in',
    description: 'Relationship maintenance draft.',
    targetTypes: ['partnership'],
    placement: 'primary',
    handbookSlugs: ['voice-and-tone', 'agent-faq'],
    instructions: `Draft a check-in message in Voice. Save as a Note. Do not send.`,
  }),
  task({
    id: 'partnership.suggest_joint_opps',
    label: 'Suggest joint opportunities',
    description: 'Ideas from shared company pipeline.',
    targetTypes: ['partnership'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Suggest joint opportunity ideas from the shared company's open deals/opps. Suggest only; do not create records unless asked.`,
  }),
  task({
    id: 'partnership.distill_notes',
    label: 'Distill notes',
    description: 'Pin high-signal notes.',
    targetTypes: ['partnership'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Review notes. Pin high-signal items. Optionally refresh summary.`,
  }),
  task({
    id: 'partnership.capture_decision',
    label: 'Capture decision',
    description: 'Log a Decision.',
    targetTypes: ['partnership'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Create a Decision linked to this Partnership.`,
  }),
  task({
    id: 'partnership.log_transcript',
    label: 'Log transcript',
    description: 'Parse notes into updates.',
    targetTypes: ['partnership'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `The human will paste notes after this prompt. Append a Note; propose Plan items; extract Decisions.`,
  }),

  // Raise
  task({
    id: 'raise.enrich_thesis',
    label: 'Enrich thesis',
    description: 'Research firm; write thesisFit + summary.',
    targetTypes: ['raise'],
    placement: 'primary',
    handbookSlugs: ['about-us', 'product', 'agent-faq'],
    instructions: `Research the investor firm (linked Company). Update thesisFit and summary. Append sources as a Note.
Ongoing investor relationship stays a Partnership; do not conflate with this Raise process.`,
  }),
  task({
    id: 'raise.propose_plan',
    label: 'Propose Plan',
    description: 'Intro → meeting → diligence Plan items.',
    targetTypes: ['raise'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Propose dated Plan items for the raise process (intro, meeting, diligence, materials).`,
  }),
  task({
    id: 'raise.investor_brief',
    label: 'Investor brief',
    description: 'Firm + people + related Partnership + Decisions.',
    targetTypes: ['raise'],
    placement: 'primary',
    handbookSlugs: ['about-us', 'agent-faq'],
    instructions: `Produce an investor brief: firm, key people, thesisFit, related Partnership if any, open Decisions.
Optionally save as a Note.`,
  }),
  task({
    id: 'raise.warm_path',
    label: 'Warm path from CRM',
    description: 'Suggest intros from existing People/Positions.',
    targetTypes: ['raise'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Suggest warm intro paths using People and Positions already in the CRM only.
Do not invent a graph product — list concrete existing contacts and why they help.`,
  }),
  task({
    id: 'raise.capture_pass',
    label: 'Capture pass reason',
    description: 'Structure pass into passReason + note/Decision.',
    targetTypes: ['raise'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `If this raise is a pass (or the human is recording one), set passReason, update summary, append a Note, and optionally a Decision.
Ask before setting stage to passed.`,
  }),
  task({
    id: 'raise.draft_update',
    label: 'Draft update',
    description: 'Investor update in Voice.',
    targetTypes: ['raise'],
    placement: 'primary',
    handbookSlugs: ['voice-and-tone', 'about-us', 'agent-faq'],
    instructions: `Draft an investor update in Voice. Save as a Note. Do not send. Do not invent metrics.`,
  }),
  task({
    id: 'raise.distill_notes',
    label: 'Distill notes',
    description: 'Pin high-signal notes.',
    targetTypes: ['raise'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Review notes. Pin high-signal items. Optionally refresh summary.`,
  }),
  task({
    id: 'raise.capture_decision',
    label: 'Capture decision',
    description: 'Log a Decision.',
    targetTypes: ['raise'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Create a Decision linked to this Raise.`,
  }),
  task({
    id: 'raise.log_transcript',
    label: 'Log transcript',
    description: 'Parse notes into updates.',
    targetTypes: ['raise'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `The human will paste notes after this prompt. Append a Note; propose Plan items; extract Decisions.`,
  }),

  // Candidate
  task({
    id: 'candidate.score',
    label: 'Score candidate',
    description: 'Fit vs role + handbook; note on Candidate.',
    targetTypes: ['candidate'],
    placement: 'primary',
    handbookSlugs: ['team-and-roles', 'agent-faq'],
    instructions: `Score fit vs the Role and Team and roles handbook. Append interview/feedback Notes on the Candidate (not the Person).
Do not put hiring pipeline fields on Person.`,
  }),
  task({
    id: 'candidate.summarise_interview',
    label: 'Summarise interview',
    description: 'Distill feedback; pin signal.',
    targetTypes: ['candidate'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Distill Candidate notes into a clear interview summary Note. Pin high-signal feedback.`,
  }),
  task({
    id: 'candidate.suggest_questions',
    label: 'Suggest questions',
    description: 'From role + gaps in notes.',
    targetTypes: ['candidate'],
    placement: 'primary',
    handbookSlugs: ['team-and-roles', 'agent-faq'],
    instructions: `Suggest interview questions from the Role and gaps in Candidate notes. Save as a Note on the Candidate.`,
  }),
  task({
    id: 'candidate.draft_outcome',
    label: 'Draft outcome note',
    description: 'Pass / nurture / offer language (human sends).',
    targetTypes: ['candidate'],
    placement: 'primary',
    handbookSlugs: ['voice-and-tone', 'agent-faq'],
    instructions: `Draft pass / nurture / offer communication in Voice. Save as a Note. Human sends. Ask before changing Candidate status.`,
  }),
  task({
    id: 'candidate.enrich_person',
    label: 'Enrich candidate person',
    description: 'Person enrich scoped via Candidate.',
    targetTypes: ['candidate'],
    placement: 'overflow',
    handbookSlugs: ['agent-faq'],
    instructions: `Enrich the linked Person (summary, socials, Positions). Keep hiring state on the Candidate only.`,
  }),

  // Role
  task({
    id: 'role.compare_shortlist',
    label: 'Compare shortlist',
    description: 'Side-by-side for in-process candidates.',
    targetTypes: ['role'],
    placement: 'primary',
    handbookSlugs: ['team-and-roles', 'agent-faq'],
    instructions: `Compare in-process Candidates for this Role using their notes and Person summaries.
Produce a short comparison. Optionally save as a Note on the Role context (or each Candidate). Do not change statuses without asking.`,
  }),

  // Handbook
  task({
    id: 'handbook.consistency_check',
    label: 'Consistency check',
    description: 'CRM summaries vs Voice / ICP / How we sell.',
    targetTypes: ['handbook'],
    placement: 'primary',
    handbookSlugs: ['voice-and-tone', 'ideal-customer-profile', 'how-we-sell', 'agent-faq'],
    instructions: `Check this handbook page for consistency with related CRM realities and sibling handbook pages.
Propose edits; do not invent product claims.`,
  }),
  task({
    id: 'handbook.draft_update',
    label: 'Draft update',
    description: 'Propose page edits from product reality.',
    targetTypes: ['handbook'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Propose an updated markdown draft for this handbook page from current product/CRM context.
Show a diff-style proposal before applying.`,
  }),
  task({
    id: 'handbook.fill_gap',
    label: 'Fill a gap',
    description: 'e.g. case study from a won Deal.',
    targetTypes: ['handbook'],
    placement: 'overflow',
    handbookSlugs: ['voice-and-tone', 'product', 'agent-faq'],
    instructions: `Identify a content gap related to this page (e.g. case study from a won Deal) and draft content in Voice.`,
  }),

  // Workspace
  task({
    id: 'workspace.daily_brief',
    label: 'Daily brief',
    description: 'Attention: overdue Plans, stale contacts, empty summaries.',
    targetTypes: ['workspace'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Produce a daily brief for this workspace: overdue Plans, stale contacts, empty agent summaries, pipeline risks.
Suggest which agent tasks to run next. Prefer listing; mutate only if the human asks.`,
  }),
  task({
    id: 'workspace.pipeline_review',
    label: 'Pipeline review',
    description: 'Deals / Opps / Raises needing Plan or summary.',
    targetTypes: ['workspace'],
    placement: 'primary',
    handbookSlugs: ['how-we-sell', 'agent-faq'],
    instructions: `Review open Deals, Opportunities, and Raises. Flag records needing Propose Plan or Refresh summary.`,
  }),
  task({
    id: 'workspace.stale_triage',
    label: 'Stale relationship triage',
    description: 'People past last-contacted threshold.',
    targetTypes: ['workspace'],
    placement: 'primary',
    handbookSlugs: ['voice-and-tone', 'agent-faq'],
    instructions: `List People past a ~14 day lastContactedAt threshold who matter for open pipeline.
Suggest Draft outreach or Plan items. Do not spam everyone.`,
  }),
  task({
    id: 'workspace.weekly_plan',
    label: 'Weekly plan',
    description: 'Propose Plan items across open pipeline.',
    targetTypes: ['workspace'],
    placement: 'primary',
    handbookSlugs: ['how-we-sell', 'agent-faq'],
    instructions: `Propose a week of Plan items across open Deals, Opportunities, Raises, and Partnerships.
Create Plan items only when clearly useful; otherwise list proposals for confirmation.`,
  }),
  task({
    id: 'workspace.empty_field_sweep',
    label: 'Empty-field sweep',
    description: 'Records missing summary / ICP / thesisFit.',
    targetTypes: ['workspace'],
    placement: 'primary',
    handbookSlugs: ['agent-faq'],
    instructions: `Find records missing summary, company icpFit, or raise thesisFit.
Prioritise open pipeline. Suggest Enrich / Score / Refresh tasks per record.`,
  }),
]

export function findTask(id: string): AgentTaskDefinition | undefined {
  return AGENT_TASK_DEFINITIONS.find((definition) => definition.id === id)
}

export function tasksFor(targetType: AgentTaskTargetType): readonly AgentTaskDefinition[] {
  return AGENT_TASK_DEFINITIONS.filter((definition) => definition.targetTypes.includes(targetType))
}
