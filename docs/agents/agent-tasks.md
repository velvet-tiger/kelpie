# Agent tasks

Kelpie ships 69 prompt recipes — enrich this company, draft outreach in our voice, brief me for this meeting, sweep the pipeline for records with no plan. Each one resolves into a complete, context-packed prompt from your workspace's own data. You bring the agent that runs it.

## Two paths to an agent

Kelpie talks to agents in two different directions. They solve different jobs and do not substitute for each other.

| Path | Direction | Use for |
| --- | --- | --- |
| **MCP connection** | Your agent connects **to** Kelpie | Day-to-day work — list people, update deals, search the handbook |
| **Registered agent** | Kelpie POSTs **to** your endpoint | **Run** on record pages — one-click task dispatch from the UI |

Connecting Claude, Cursor, or any MCP client does **not** register that client for Run. MCP clients are not HTTP receivers Kelpie can POST to. For MCP setup, see [Connect an agent](connect-an-agent.md).

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

**Copy** puts the resolved prompt on your clipboard. Paste it into Claude, ChatGPT, Cursor, or any agent — nothing needs configuring, and if the agent is connected over MCP it can act on the prompt directly. Copy is the zero-setup way to use agent tasks.

## Run

**Run** sends the identical resolved payload to a **registered agent** — an HTTP endpoint you operate. Copy and Run resolve from the same source, so the two can never drift.

Register agents on **Admin → MCP**: a name, an endpoint URL, and an optional auth header. The header is sent as `Authorization` on every dispatch, stored encrypted, and never shown again. A URL with credentials embedded in it is refused — the auth header is where the secret belongs. Registering is admin work; running is open to every member, because the Run action on record pages is built from this list.

## What works as a registered agent

A registered agent is **not** a product picker. Kelpie does not ship receivers for Claude, OpenAI, or any other model. It POSTs JSON to any HTTP endpoint you register. Your receiver decides what to do with the prompt.

**Works:**

- A webhook or small HTTP service you write (Node, Python, Go, …) that receives the task, calls a model, and reads/writes Kelpie over the API or MCP
- Automation platforms with a webhook trigger (n8n, Make, Zapier) wired to an AI step plus Kelpie API calls
- An internal service on your network (`http://automation.internal/…` is valid on a self-hosted install)
- A hosted AI module on Kelpie Cloud (registers itself as a receiver and reads `base_prompt`)

**Does not work directly:**

- **Claude Desktop, Cursor, ChatGPT** — MCP/API *clients*, not HTTP servers Kelpie can POST to
- **Anthropic, OpenAI, or other model API URLs** — they do not accept Kelpie task payloads
- **Kelpie's own `/mcp` endpoint** — that is for agents connecting *to* Kelpie, not for Run dispatches

To use Claude or Cursor without building a receiver, use **Copy prompt** and connect the client to Kelpie over MCP separately.

## The run log

Each Run creates a run: `queued`, then `running` while the POST is in flight, then `succeeded` on a 2xx or `failed` with the reason (a non-2xx status, a timeout after 10 seconds, a refused address). **One attempt, deliberately** — re-POSTing a task risks an agent doing the whole job twice, and you are on the page to re-run it. There is no completion callback: what the agent did shows up on the records themselves, through the same API everything uses.

Recent runs appear on **Admin → MCP** below the registered agents list.

## Dispatch contract

When you click Run (or `POST /v1/agent-tasks/:task_id/run`), Kelpie resolves the task and POSTs the result to the registered endpoint.

### Request

```
POST {registered endpoint URL}
Content-Type: application/json
Authorization: {stored auth header, if set}
```

Body:

```json
{
  "run_id": "run_01J…",
  "workspace_id": "ws_01J…",
  "task_id": "company.enrich",
  "target_type": "company",
  "target_id": "com_01J…",
  "prompt": "# Agent task: Enrich company\n…",
  "base_prompt": "# Enrich company\n…",
  "context": {
    "target_label": "Brightline Health",
    "deep_link": "/companies/com_01J…",
    "handbook_slugs": ["ideal-customer-profile", "agent-faq"],
    "pinned_note_ids": ["not_01J…"],
    "open_plan_ids": [],
    "open_decision_ids": ["dec_01J…"],
    "related": {
      "person_ids": ["per_01J…"],
      "deal_ids": ["dea_01J…"]
    }
  }
}
```

`related` keys vary by target type (`person_ids`, `deal_ids`, `position_ids`, …). Which keys appear depends on the task and record.

### Response

Answer **2xx within 10 seconds** to mark the dispatch succeeded. Kelpie records only whether the POST landed, not whether your agent finished the work. Do the model call and CRM updates **after** answering if the work will take longer.

Non-2xx, a timeout, or a redirect (redirects are never followed) marks the run `failed` with a reason. Kelpie does not retry — you re-run from the page.

### Rules for the receiver

- **Dedupe on `run_id`** if your infrastructure might replay requests.
- **`workspace_id` names the workspace**; the dispatch carries no Kelpie credential. Give your receiver its own API key (`kp_live_…` or `kp_user_…`) and have it read and write through the normal API or MCP.
- **Pick the right prompt.** Use `prompt` for an agent that runs its own tool loop over Kelpie; use `base_prompt` for one that returns structured operations for a caller to apply.
- **Register the final URL.** Redirects are not followed.
- **Keep secrets in the auth header field**, not in the endpoint URL — URLs with embedded credentials are refused at registration.

### REST endpoints

| Endpoint | Role |
| --- | --- |
| `GET /v1/agents` | List registered agents (any member) |
| `POST /v1/agents` | Register an agent (admin) |
| `PATCH /v1/agents/:id` | Update name, endpoint, or auth header (admin) |
| `DELETE /v1/agents/:id` | Remove agent and its run log (admin) |
| `POST /v1/agent-tasks/:task_id/resolve` | Resolve without dispatching |
| `POST /v1/agent-tasks/:task_id/run` | Resolve and dispatch |
| `GET /v1/agent-runs` | List runs; filter `?agent_id=` and `?status=` |
| `GET /v1/agent-runs/:id` | Poll one run |

Full wire detail: the [API reference](../api-reference.md) and the canonical spec [`agent-tasks.md`](../../../docs/agent-tasks.md) beside this repository.

## Where the boundaries are

Agent tasks have no MCP tools of their own — an agent cannot list or dispatch tasks over MCP today. An agent that wants a context pack is handed one (Copy), or your automation POSTs the resolve endpoint over REST with its key.

There is no callback for an agent to report task completion. A run's lifecycle is the dispatch only; the work itself shows up on the records through the ordinary API.
