# Pipelines and hiring

Everything that moves through stages: enquiries, deals, opportunities, partnerships, and raises on a shared board, and roles with candidates in hiring.

## The five pipelines

Kelpie deliberately keeps five kinds of pipeline apart, because an inbound enquiry and a sales deal do not want the same fields:

- **Enquiries** — the top of the funnel. Inbound requests from a website form, an email, or a referral. Free-text `source`, optional company. Once qualified, one click on the detail page converts an enquiry to a **Deal** (name, company, owner, and linked people carry over; the enquiry moves to Closed and remembers the deal on `converted_deal_id`).
- **Deals** — the sales pipeline. Value, owner, expected close, and the agent fields: competitors, risks, why we win.
- **Opportunities** — non-sales chances: grants, accelerators, tenders, press, speaking. Each carries a `kind` so the list can be sliced.
- **Fundraising (Raises)** — one raise per firm per round: thesis fit, check size, and a pass reason when it ends that way. The ongoing investor relationship lives as a Partnership; the raise is the process.
- **Partnerships** — ongoing two-way relationships: integrations, channel, advisors, investors. Status, a next touchpoint date, goals, and what success looks like.

## The board

All five share one kanban. Drag a card between columns to change its stage; switch to the list view to see the same records grouped. Each pipeline also has a detail page per record with its notes, plans, and decisions.

<!-- screenshot: deals kanban -->

## Configuring stages

Every pipeline's stages belong to your workspace — rename them, reorder them, mark them open or closed, add and remove them from the pipeline's settings page. A new workspace starts with a sensible seeded set. Removing a stage that still holds records asks where to move them first, so nothing is stranded.

Stage slugs matter for imports: a CSV import resolves stage names against your own pipeline, so renaming a stage's label does not break files that used the slug. See [Import and export](import-and-export.md).

<!-- screenshot: stage settings -->

## What the dashboard watches

Open counts per pipeline, partnership touchpoints coming due, and pipeline records that have no open plan item are all dashboard signals. The habit they encourage: every open record carries a dated plan item, because "next step" text fields do not exist in Kelpie — dated, owned plan items replace them ([Planning and decisions](planning-and-decisions.md)).

## Hiring: roles and candidates

A **Role** is an opening: a title, open or closed. A **Candidate** is the link between a person and a role — which is why one person can be interviewing for one role and sitting in the nurture pile for another at the same time, without the two processes colliding.

The candidate carries the pipeline state:

- **Status**: in process, nurture, hired, passed, or withdrawn.
- **Interview stage** (sourced through offer) exists only while the status is *in process*. Leaving the process clears the stage; rejoining restores the one they had. The two can never contradict each other.
- An optional **referrer** links the person who made the introduction.

Interview notes attach to the candidate, not the person, so feedback about one role's process does not leak into another's.

A person's page shows hiring information only when they are attached to a role — Kelpie never puts hiring fields on a person directly.

<!-- screenshot: role detail with candidates -->
