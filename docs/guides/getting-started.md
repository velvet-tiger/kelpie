# Getting started

Your first session in Kelpie: create an account, set up a workspace, and learn your way around. This guide applies to any Kelpie — self-hosted or hosted. If nothing is running yet, start with [Installation](../self-hosting/installation.md).

## What Kelpie is

Kelpie is a CRM and a company handbook that AI agents can operate. Your team works in the pages described below; an agent you bring reads and writes the same records through the same API. Kelpie bundles no AI of its own.

## Create your account

Sign up with your name, email, and a password of at least 12 characters. Kelpie then emails you a verification link, and you cannot create a workspace until you have clicked it. On a fresh self-hosted install with email set to `log`, the link is printed in the server log instead of sent — copy it from there.

Joining by invitation skips verification: a valid invite link already proves you control the address.

## Set up your workspace

A workspace is your company brain — CRM records, handbook, and team. You choose:

- **Name and slug.** The slug is the workspace's short handle; it must be unique on the install.
- **Timezone.** This decides what "today" means for the whole workspace: overdue plans and stale contacts are judged against your calendar, not the server's.
- **Install sample data.** Ticked, Kelpie fills the workspace with a small set of companies, people, deals, and the rest, so you explore a working CRM instead of an empty one. It can also be installed later from Admin → Data, but only while the workspace holds no real records.

<!-- screenshot: onboarding workspace step -->

## Invite your team

Optional at this point; you can always invite people later from Admin → Team. Invitees get admin or member roles — what those mean is covered in [Administration](administration.md).

## Review the starter handbook

Every new workspace comes with a starter handbook: About us, Product, Ideal customer profile, Voice and tone, Pricing, How we sell, and more. The pages exist as stubs for your team to fill in. Agents read these pages to learn what your company is, so filling them in early pays off immediately. See [Handbook](handbook.md).

<!-- screenshot: onboarding handbook step -->

## A tour of the app

The sidebar is the map:

- **Dashboard** — what needs attention today (below).
- **Search** — the box in the header searches everything at once: people, companies, deals, the other pipelines, roles, decisions, and handbook pages. Partial words work — typing `acm` finds Acme.
- **People and Companies** — who you know and where they work. Job titles live on the link between a person and a company, so one person can hold titles at several companies. See [Records](records.md).
- **Deals, Opportunities, Fundraising, Partnerships** — four pipelines on one kanban. See [Pipelines](pipelines.md).
- **Hiring** — roles you are hiring for, and candidates attached to them.
- **Lists** — hand-picked collections of records: a conference shortlist, key accounts, a press list. See [Records](records.md#lists).
- **Planning** — every dated action item across the pipelines, as a list or a calendar.
- **Decisions** — what you decided and promised, attached to the records the decisions are about.
- **Forms** — public forms for your website that create CRM records when submitted. See [Forms](forms.md).
- **Handbook** — the markdown pages your team and your agents both read.
- **Admin** — workspace settings, team, data import and export, API keys, webhooks, MCP, and modules. Admin-only.

<!-- screenshot: app shell with sidebar -->

## Your dashboard

The dashboard is a daily brief built from your own data: open counts for each pipeline, plan items overdue and due soon, partnership touchpoints coming up, people you have not contacted in 14 days, and the latest activity, notes, and decisions. Each signal shows a handful of rows and the true total, so "4 of 23 overdue" reads as 23, not 4. Overdue is judged in your workspace's timezone.

<!-- screenshot: dashboard -->

## Joining an existing workspace

An invitation email lands on a join page. If you already have an account, accepting adds the workspace; if not, you sign up on the way through and the invitation verifies your email for you. Signing in from the join page returns you to the invitation rather than dropping you elsewhere.

## Where next

- [Records](records.md) — people, companies, positions, search, and lists.
- [Pipelines](pipelines.md) — deals, opportunities, fundraising, partnerships, and hiring.
- [Planning and decisions](planning-and-decisions.md) — notes, plans, decisions, and the timeline.
- [Connect an agent](../agents/connect-an-agent.md) — point Claude, Cursor, or any MCP client at this workspace.
