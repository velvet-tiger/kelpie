# Kelpie AI

Kelpie AI runs [agent tasks](agent-tasks.md) for you with your own OpenAI or Anthropic API key. It is the zero-setup way to use **Run**: you do not write a receiver or host an endpoint.

It comes from the optional `ai` module. A project made with `npm create kelpie` includes it. Nothing calls a model until an admin enters a key.

## Turn it on

1. Go to **Admin → AI**.
2. Pick a provider: OpenAI or Anthropic.
3. Paste an API key from that provider.
4. Optional: name a model. Leave it empty to use the default (`gpt-5.6-luna` for OpenAI, `claude-opus-5` for Anthropic).
5. Select **Enable AI**.

Kelpie AI then shows in the **Run** menu on every record page, next to any agent you registered yourself.

The key is stored encrypted. The page shows only its last four characters, and no endpoint returns it. **Disable AI** deletes the stored key and removes Kelpie AI from the Run menu. The run log stays.

Only admins can change these settings. Every member can run a task.

## What a run does

1. Kelpie reads the record, its pinned notes, open plans and decisions, related records, and the handbook pages the task names.
2. It sends the task and that context to the model once. The model gets no tools and cannot read or write anything itself.
3. The model replies with a summary and a list of operations: update allowed fields on the record, add a note, pin a note, add a plan item, record a decision, or add a position.
4. Kelpie checks each operation and applies it through the same tools any agent uses. It drops fields and operations that the task does not allow, and records each drop.

The **Admin → AI** run log shows each run: its status, the model, the token counts, the summary, and each operation with its outcome.

If the provider refuses the key, or the account has no quota, the run fails with the provider's message. Fix the key in **Admin → AI** and run the task again.

## Add a person from notes

On **People**, **Add from notes** (beside **Add person**) builds a full record from what you already know.

1. Paste anything about the person: a name, an email, a LinkedIn URL, a signature block, meeting notes.
2. Kelpie AI looks the person up and shows up to three matches. Pick the right one. If the person is already in Kelpie, choose **Update** that record or **Create new**.
3. Kelpie AI researches the person and lists what it will create: the Person, their Company (or a link to one you already have), a Position with their title, and a pinned research note with its sources. It can also suggest a Partnership, Deal or Enquiry when your notes point to one; those start unticked, with the reason shown. Untick anything you do not want.
4. Kelpie creates the ticked items and links to each one.

Updating an existing Person only adds: it fills empty fields and adds new tags, phones and profiles. It does not replace the name, the summary, or anything else that already has a value.

The two AI steps each count as one run in the run log and against any monthly limit. With web search on, each step can take a minute or more.

**Web search.** Kelpie AI uses your provider's own web search for this, and only for this. Agent-task runs never search. It keeps a source link only when the search really returned that page. To work from your notes and the CRM only, switch **Web search** off on **Admin → AI**.

**Without Kelpie AI**, **Add from notes** still opens. It gives you a prompt, with your notes in it, to paste into your own agent. That agent then creates the records through MCP.

## A key for the whole install

An operator can set a fallback key for every workspace in the environment:

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `openai` or `anthropic`. `AI_API_KEY` is ignored without it |
| `AI_API_KEY` | The provider API key |
| `AI_MODEL` | Optional. The model for that provider |

A workspace key always wins. A fallback key is only used for the provider it belongs to. The settings page says which key a workspace uses, and never shows any part of the fallback key.

The full list of variables, with the run limits and timeouts, is in [Configuration](../self-hosting/configuration.md#kelpie-ai).

## Leave it out

Remove `createAiModule()` from `kelpie.config.ts`, `aiUi` from `kelpie.ui.config.ts`, and `resealAiSecrets` from `src/reseal.ts`. An install without the module has no AI tables and no AI page. An admin can also turn the module off for one workspace on **Admin → Modules**.

## How a run reaches Kelpie AI

Kelpie hands the task to the module inside the same server process. It does not send it over the network, so there is no URL to configure and nothing to change behind a proxy or in a container. On **Admin → MCP**, Kelpie AI shows as "Runs inside Kelpie".
