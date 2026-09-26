---
name: kelpie
description: Work in a Kelpie CRM workspace over its MCP tools or REST API. Use when reading or changing people, companies, positions, enquiries, deals, opportunities, raises, partnerships, roles, candidates, notes, plan items, decisions, or handbook pages in Kelpie, when briefing on an account or meeting, or when connecting an agent to a Kelpie deployment.
---

# Kelpie

Kelpie is an open-source CRM and company handbook for one workspace. People and agents use the same public API. Every operation in the app is also an MCP tool, so you read and write the same records that the team does, and the server refuses the same bad requests.

## Connect

If no `kelpie` MCP server is connected, the user must connect one. You cannot do it without their API key.

1. The user creates a key. A workspace key (`kp_live_…`) comes from **Admin → API keys**. A personal key (`kp_user_…`) comes from **Account → API keys** and acts as that user. The app shows a key once only.
2. The endpoint is the app's origin plus `/mcp`. On a local install it is `http://localhost:5173/mcp`.
3. For Claude Code:

   ```bash
   claude mcp add kelpie --transport http https://your-kelpie.example.com/mcp --header "Authorization: Bearer kp_live_…"
   ```

**Admin → MCP** in the app shows the exact URL, a config snippet, and the live tool catalog. Never ask the user to paste a key into the chat when they can put it in the MCP config.

One key reaches one workspace only. There is no workspace argument on any tool.

## Before you write anything

Do these steps in this order. They are the most important part of this skill.

1. **Find the record.** Use `search_query` with a name, email, domain, or job title. It searches every collection at once. Do not create a record until you know that it does not exist already.
2. **Read the decisions.** Call `decisions_list` with `target_type` and `target_id`. A decision is a commitment that the team already made. Do not contradict one. If the request conflicts with a decision, stop and tell the user.
3. **Read the pinned notes.** Call `notes_list` with `pinned: true`. Someone pinned them because they are the most important facts.
4. **Read the handbook before you write for a customer.** Call `handbook_pages_list`, then read the pages about voice, ICP, and how the company sells. Do not guess the company's voice.
5. **Check `do_not_contact` on a person** before you draft any outreach to them. If it is `true`, do not draft outreach.

## Rules for the data model

These rules come from the product. Do not work around them.

- **A job title is on a Position, never on a Person.** A Position links one person to one company and holds the title. One person can hold several positions. To link a person to a company, call `positions_create` with `person_id`, `company_id`, and `title`.
- **A person has one `name`.** `first_name`, `last_name`, `salutation`, and `suffix` are optional. Send them only when you know them. Do not split a name into parts yourself. A change to a part does not rename the person; send `name` to do that.
- **Next steps are plan items, not text.** No "next step" field exists. Call `plan_items_create` with a `date`, a `title`, and an `owner_id` when you know the owner. Plan items attach to enquiries, deals, opportunities, raises, partnerships, and events.
- **A Deal is not an Opportunity.** A Deal is a sale. An Opportunity is a chance that is not a sale: a grant, an accelerator, a tender, press, or a speaking slot. A Raise is one fundraising process with one firm. The ongoing investor relationship is a Partnership.
- **Hiring data goes on a Candidate, never on a Person.** A Candidate links a person to a Role. Interview notes attach to the Candidate.
- **Notes are information. Decisions are commitments.** Put a promise or an agreement in a decision (`decisions_create`) with the `body` and, if known, the `rationale`. Put everything else in a note.
- **Do not invent facts.** If you do not know a value, leave the field empty. Put uncertain findings in a note and say where they came from.

Full model, field names, and allowed values: [references/domain-model.md](references/domain-model.md).

## How the tools work

- Tool names are the resource, then the verb: `people_list`, `people_get`, `people_create`, `people_update`, `people_delete`. Most resources have these five tools.
- The catalog changes when modules are on or off. Get the current list from the MCP client. Do not assume that a tool exists.
- Arguments and results are `snake_case` JSON.
- Lists return `data` and `next_cursor`. To get the next page, send `next_cursor` back as `cursor`. Do not build a cursor yourself. `limit` is 1 to 200; the default is 50.
- Most lists accept `q` for free text. An id filter accepts one id or an array of up to 200 ids.
- Ids have a type prefix, for example `per_…`, `com_…`, `dea_…`, `dec_…`, `not_…`.
- Money is an integer number of cents plus a currency code: `value_cents: 1500000` is 15,000.00.
- Timestamps are ISO 8601 in UTC. A plan item `date` is a calendar date.
- An `update` is a partial change. Send only the fields that you change.
- To move a pipeline record to another stage, set `stage_id`. Get the stage ids from `pipeline_stages_list` with `kind` (`enquiry`, `deal`, `opportunity`, `raise`, or `partnership`). Each workspace has its own stages. Each stage has `open: true` or `open: false`. There is no separate "won" or "lost" field.
- `custom_fields` is an object of workspace-defined keys. Call `custom_fields_list` before you write one. A key that the workspace does not define gives an error.
- The activity timeline (`activities_list`) is read-only. The server writes it. To record a meeting or a call, write a note.

## When a tool refuses

A refusal is correct behaviour. Read the message, correct the request, and try again. Do not try the same request again without a change.

| Result | What to do |
| --- | --- |
| `validation_failed` / 422 | A field is wrong. The details name the field. Correct it. |
| `not_found` / 404 | The id is wrong, or the record was deleted. Search again. |
| 409 | A conflict, for example a record that is already converted, or a duplicate list member. Read the message. |
| "entitlement required" | An admin turned that module off. Tell the user. |
| 401 | The key is missing, wrong, or revoked. The user must fix the MCP config. |
| 429 | Too many requests. Wait for `Retry-After`, then continue. |

## Deletes

A delete cannot be undone. Get a clear "yes" from the user before you call any `*_delete` tool. A handbook page delete also deletes every page under it. A pipeline stage delete needs `move_to` when the stage holds records.

## Common tasks

Step-by-step recipes: [references/workflows.md](references/workflows.md). They cover:

- Log a meeting or a call.
- Add a person and their job.
- Brief the user before a meeting.
- Move a deal and set the next step.
- Qualify and convert an enquiry.
- Research a company against the ICP.
- Review the pipeline for records with no plan.

## Agent tasks from the app

A user can click **Copy prompt** on a record page and paste the result to you. That prompt already contains the record, its pinned notes, its open plan items, its decisions, and the handbook pages that the task needs. Follow its write policy. Use the tools to fetch anything else that it names by id.
