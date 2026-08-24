# Notes, plans, and decisions

Kelpie's memory layer: what happened, what happens next, and what was decided. It is the part of the CRM your agents lean on hardest, so keeping it honest pays twice.

## Notes

Notes attach to any record — a person, a company, a deal, a candidate — and support markdown. Two habits make them useful:

- **Pin the high-signal ones.** Pinned notes float to the top of the record, and they are what an agent task loads first when it builds a prompt for that record. A pinned note is you telling every future reader, human or machine, "start here".
- **Write for the reader who was not in the room.** Notes are the raw material summaries and briefs are built from.

## The activity timeline

Every record carries a timeline of what happened to it: edits, links, form submissions, and the rest. It is written automatically by the changes it describes and is read-only — you cannot add or edit timeline entries, which is what makes it trustworthy.

## Plan items

A plan item is a dated action with a title, an owner, and a status (to do, in progress, done). Plans attach to pipeline records — deals, opportunities, raises, partnerships — and replace the "next step" text field other CRMs use, because a date and an owner can be counted and chased while a text field just goes stale.

The **Planning** page shows every plan item across the workspace, as a list or a calendar. The dashboard counts them: overdue and due soon, judged against your workspace's timezone, so a Melbourne team's morning does not show yesterday's date as overdue because the server runs on UTC.

<!-- screenshot: planning page -->

## Decisions

A decision records what you decided or promised: the decision itself, the rationale, who owns it, when it was decided, and optionally when it falls due. Decisions attach to the record they are about and also appear in one workspace-wide log.

Decisions are separate from notes on purpose. A note is information; a decision is a commitment. Agents are instructed not to contradict open decisions, and "what did we decide about Acme?" is a question the Decisions tab answers directly.

<!-- screenshot: decisions page -->

## The dashboard reads all of it

The daily-brief signals — overdue and due-soon plans, stale contacts, touchpoints, recent notes and decisions — are computed from this layer. Every signal shows its true total beside the rows it displays. If the dashboard looks quiet, it is because plans are current and contacts are warm, which is the point.

## Why agents like this shape

When an agent task is resolved for a record, Kelpie packs the record's fields, its pinned notes, its open plan items, and its open decisions into the prompt. A workspace that pins good notes, dates its next steps, and records its decisions gets sharper agent output with no extra prompting. See [Agent tasks](../agents/agent-tasks.md).
