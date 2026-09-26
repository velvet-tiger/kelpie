# Kelpie workflows

Recipes for common requests. Each one assumes that you did the checks in "Before you write anything" in `SKILL.md`: find the record, read its decisions, read its pinned notes.

When a step creates a record, use the id from the result in the next step. Do not guess ids.

## Log a meeting or a call

1. Find each person with `search_query`. Find the pipeline record that the meeting was about, if there is one.
2. Write one note with `notes_create` on the most relevant record. Usually this is the deal or other pipeline record. If there is no pipeline record, use the person or the company. Write for a reader who was not there: who attended, what they said, what changed.
3. If someone made a commitment, record it with `decisions_create`. Include the `rationale` when it is known.
4. For each agreed next step, call `plan_items_create` with a `date`, a `title`, and an `owner_id`.
5. Set `last_contacted_at` on each person you spoke to with `people_update`.
6. Change `relationship` or `influence` on a person only if the meeting clearly showed it.

Do not pin the note unless the user asks, or unless it holds a fact that every future reader must see first.

## Add a person and their job

1. Search for the person by email and by name. If the person exists, update them. Do not create a duplicate.
2. Search for the company by domain and by name. Create it with `companies_create` only if it does not exist.
3. Create the person with `people_create`. Send `name`. Send `first_name` and `last_name` too only if you know them.
4. Link them with `positions_create`: `person_id`, `company_id`, `title`.

If the person changes jobs, create a new Position at the new company. Ask the user before you delete the old one.

## Brief the user before a meeting

1. Find the people and the company.
2. For the company, read: `companies_get`, `positions_list` with `company_id`, and the deals, opportunities, partnerships, or raises with that `company_id`.
3. For each record, read the decisions, the pinned notes, then the recent notes, and the open plan items (`plan_items_list` with `status: ["todo", "in_progress"]`).
4. Read `activities_list` for the recent history of the main records.
5. Write the brief for the user. Put open decisions and overdue plan items first. Say which facts come from notes and which come from fields. Do not write the brief into Kelpie unless the user asks.

## Move a deal and set the next step

1. Get the deal with `deals_get`.
2. Get the stages with `pipeline_stages_list` and `kind: "deal"`. Match the stage that the user named by its `label` or `slug`.
3. Call `deals_update` with the new `stage_id`. Change `value_cents`, `expected_close`, `risks`, or `why_win` only if the user gave new values.
4. If the new stage is open, make sure the deal has an open plan item. If it has none, ask the user for the next step and create one.
5. If the new stage is closed and the deal was lost, record the reason in a note. If a commitment ended the deal, record it as a decision.

## Qualify and convert an enquiry

1. Read the enquiry, its notes, and its decisions.
2. If it is qualified and the user agrees, call `enquiries_convert_to_deal` with the enquiry `id`. The server makes the deal, copies the name, company, owner, and people, and closes the enquiry.
3. Read the new deal. Set `value_cents`, `currency`, and `expected_close` if they are known.
4. Create a plan item on the new deal for the next step.

If the enquiry is not a sale (for example a press request or a grant), use `enquiries_convert` with the correct `target_type` (`opportunity`, `partnership`, or `raise`).

If the enquiry is not qualified, move it to a closed stage and write a note with the reason.

## Research a company against the ICP

1. Read the handbook: `handbook_pages_list`, then the ICP page and the product page. The slug is often `ideal-customer-profile`, but check the list.
2. Read the company and its decisions and pinned notes.
3. Do the research with the tools the user gives you. Kelpie has no web access of its own.
4. Update only the fields that you can support: `description`, `industry`, `stage`, `size_band`, `tech_stack`, `icp_fit`, `summary`.
5. Write a note that gives the sources and the reasons for the `icp_fit` value. Keep uncertain findings in the note, not in the fields.

## Review the pipeline for records with no plan

1. Call `dashboard_get`. It gives the open count per pipeline, overdue plan items, plan items due soon, stale contacts, and partnership touchpoints.
2. The dashboard does not list records with no plan. If the user pasted the **Pipeline review** task prompt from the dashboard, it already has the exact lists for deals, opportunities, and raises. Otherwise, find them yourself, one pipeline at a time:
   1. Get the open stages: `pipeline_stages_list` with `kind`, then keep the stages with `open: true`.
   2. List the records in those stages, for example `deals_list` with `stage_id` set to the open stage ids. Follow `next_cursor` to the end.
   3. List the open plan items for those records: `plan_items_list` with `target_type`, `target_id` (up to 200 ids), and `status: ["todo", "in_progress"]`.
   4. A record with no open plan item has no plan.
3. For each record with no plan, read its recent notes and decisions.
4. Give the user a list: the record, what happened last, and a proposed next step with a date.
5. Create the plan items only after the user agrees to them.

## Draft outreach

1. Check `do_not_contact` on the person. If it is `true`, stop and tell the user.
2. Read the handbook voice page and the sales pages.
3. Read the person, their positions, the company, the decisions, and the pinned notes.
4. Draft the message and give it to the user. Kelpie does not send email.
5. If the user sends it and tells you, log it as a note and set `last_contacted_at`.
