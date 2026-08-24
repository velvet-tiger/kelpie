# Agent tasks

Kelpie ships 69 prompt recipes — enrich this company, draft outreach in our voice, brief me for this meeting, sweep the pipeline for records with no plan. Each one resolves into a complete, context-packed prompt from your workspace's own data. You bring the agent that runs it.

## What a task is

Tasks appear on every record page (and at workspace level) as actions. Behind each is a definition: which record types it applies to, which handbook pages it needs, and a prompt template with a write policy — respect open decisions, prefer notes over invented facts, never send email.

## What resolving packs in

When you trigger a task for a record, Kelpie loads and renders into one markdown prompt:

- the record's fields, including the agent-oriented ones;
- its **pinned notes**;
- its **open plan items** and **open decisions**;
- the **handbook pages** the task names, resolved by slug to your workspace's own copies;
- the ids of related records, so the agent can fetch more over the API.

Workspace-level tasks (daily brief, pipeline review, stale-contact triage) point the agent at the live dashboard instead of one record, and the two sweep tasks run their queries at resolve time, embedding exact totals.

The resolved payload carries the prompt in two framings: `prompt`, written for an agent that operates Kelpie itself over MCP or the API, and `base_prompt`, the same body without that framing, for an agent that hands structured results back to a caller. Use whichever matches how your agent executes.

## Copy

**Copy** puts the resolved prompt on your clipboard. Paste it into Claude, ChatGPT, or any agent — nothing needs configuring, and if the agent is connected over MCP it can act on the prompt directly. Copy is the zero-setup way to use agent tasks.

## Run

**Run** sends the identical resolved payload to a **registered agent** — an HTTP endpoint you operate. Copy and Run resolve from the same source, so the two can never drift.

Register agents on **Admin → MCP**: a name, an endpoint URL, and an optional auth header. The header is sent as `Authorization` on every dispatch, stored encrypted, and never shown again. A URL with credentials embedded in it is refused — the auth header is where the secret belongs. Registering is admin work; running is open to every member, because the Run action on record pages is built from this list.

## The run log

Each Run creates a run: `queued`, then `running` while the POST is in flight, then `succeeded` on a 2xx or `failed` with the reason (a non-2xx status, a timeout after 10 seconds, a refused address). **One attempt, deliberately** — re-POSTing a task risks an agent doing the whole job twice, and you are on the page to re-run it. There is no completion callback: what the agent did shows up on the records themselves, through the same API everything uses.

## Building a receiving endpoint

A dispatch is one JSON POST:

```json
{
  "run_id": "run_01J…",
  "workspace_id": "ws_01J…",
  "task_id": "company.enrich",
  "target_type": "company",
  "target_id": "com_01J…",
  "prompt": "…the framed markdown prompt…",
  "base_prompt": "…the same body, unframed…",
  "context": { "…ids, slugs, and related records…" : "…" }
}
```

Rules for the receiver:

- Answer 2xx quickly to accept — you have 10 seconds before the dispatch counts as failed. Do the work after answering.
- Dedupe on `run_id` if your infrastructure might replay requests.
- `workspace_id` tells you which workspace to act on; the dispatch itself carries no credential for calling back. Give your agent its own Kelpie API key and have it read and write through the normal API or MCP.
- Redirects are not followed; register the endpoint's real, final URL.

## Where the boundaries are

Agent tasks have no MCP tools of their own — an agent cannot list or dispatch tasks over MCP today. An agent that wants a context pack is handed one (Copy), or your automation POSTs the resolve endpoint over REST with its key; see the [API reference](../api-reference.md) for the endpoints.
