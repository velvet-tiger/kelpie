# Kelpie domain model

The record types, their main fields, and the allowed values. Field names are the wire names that the tools use. Most records also have `summary`, `tags`, and `custom_fields`.

This list shows the main fields only. The tool schema from the server is the full and current contract.

## The directory

| Record | Role | Main fields |
| --- | --- | --- |
| **Person** | Someone the workspace knows. No job title and no hiring fields. | `name`, `email`, `phones`, `summary`, `influence`, `relationship`, `preferred_channel`, `last_contacted_at`, `timezone`, `do_not_contact`, `tags` |
| **Company** | An organisation. | `name`, `domain`, `description`, `industry`, `stage`, `size_band`, `account_type`, `icp_fit`, `tech_stack`, `summary`, `is_own`, `tags` |
| **Position** | Links one Person to one Company. Holds the job title. | `person_id`, `company_id`, `title` |

- Only `title` changes on a Position. To move a person to a new company, create a new Position. Delete the old one only if the user says so.
- `is_own: true` marks the workspace's own company.
- `last_contacted_at` drives the stale-contact signal on the dashboard. Set it when you log real contact.
- `do_not_contact: true` is an objection to contact. Respect it everywhere.

Allowed values:

| Field | Values |
| --- | --- |
| `influence` | `champion`, `decision_maker`, `influencer`, `blocker`, `end_user` |
| `relationship` | `cold`, `warm`, `strong` |
| `preferred_channel` | `email`, `call`, `linkedin` |
| `stage` (company) | `startup`, `growth`, `enterprise`, `other` |
| `size_band` | `1-10`, `11-50`, `51-200`, `201+` |
| `account_type` | `prospect`, `customer`, `partner`, `investor`, `other` |
| `icp_fit` | `high`, `medium`, `low`, `unknown` |

## The five pipelines

All five have `name`, `stage_id`, `owner_id`, `company_id`, `person_ids`, `summary`, and `tags`. The stages belong to the workspace. Get them from `pipeline_stages_list` with `kind`.

| Record | Use it for | Extra fields |
| --- | --- | --- |
| **Enquiry** | An inbound request that can become a Deal. | `source` (free text), `converted_deal_id` |
| **Deal** | A sale. | `value_cents`, `currency`, `expected_close`, `competitors`, `risks`, `why_win` |
| **Opportunity** | A chance that is not a sale: grant, accelerator, tender, press, speaking. | `kind` (free text), `expected_close` |
| **Raise** | One fundraising process with one firm in one round. | `check_size_cents`, `currency`, `thesis_fit`, `pass_reason`, `expected_close` |
| **Partnership** | An ongoing two-way relationship: integration, channel, advisor, investor. | `kind`, `next_touchpoint`, `goals`, `success_looks_like` |

- A stage has `open: true` or `open: false`. A record in a closed stage is finished. The stage label tells you how (for example "Won" or "Lost").
- `enquiries_convert_to_deal` makes a Deal from an Enquiry. It copies the name, company, owner, and linked people, sets `converted_deal_id`, and closes the enquiry.
- `<resource>_convert` (for example `opportunities_convert`) changes a pipeline record into another pipeline type. It moves the notes, activities, decisions, and plan items to the new record. It gives 409 if the record is already converted.
- A Raise is the process. When the process ends, the investor relationship continues as a Partnership.

## Hiring

| Record | Role | Main fields |
| --- | --- | --- |
| **Role** | An opening that the workspace is hiring for. | `title`, `status` (`open`, `closed`) |
| **Candidate** | Links a Person to a Role. Holds the hiring state. | `person_id`, `role_id`, `status`, `interview_stage`, `referrer_person_id` |

- `status`: `in_process`, `nurture`, `hired`, `passed`, `withdrawn`.
- `interview_stage` (`sourced`, `screen`, `interview`, `offer`) has a value only while `status` is `in_process`.
- Interview notes attach to the Candidate, not to the Person.

## Events

| Record | Role | Main fields |
| --- | --- | --- |
| **Event** | A meeting, a conference, a webinar. | `name`, `starts_at`, `ends_at`, `timezone`, `format` (`in_person`, `virtual`, `hybrid`), `status` (`draft`, `scheduled`, `cancelled`), `location`, `meeting_url` |
| **Attendance** | Links a Person to an Event. | `event_id`, `person_id`, `status` (`registered`, `attended`, `no_show`, `cancelled`) |

## The memory layer

These attach to a record with `target_type` and `target_id`.

| Record | Role | Main fields | Attaches to |
| --- | --- | --- | --- |
| **Note** | Information. Markdown. | `body`, `pinned` | person, company, enquiry, deal, opportunity, raise, partnership, candidate, event, attendance |
| **Decision** | A commitment or a promise. | `body`, `rationale`, `decided_at`, `owner_id`, `due_at` | the same types as a Note |
| **Plan item** | A dated action. | `date`, `title`, `owner_id`, `status` (`todo`, `in_progress`, `done`) | enquiry, deal, opportunity, raise, partnership, event |
| **Activity** | The timeline. Read-only; the server writes it. | `kind`, `action`, `detail`, `actor_label` | the same types as a Note |

- `notes_list` needs `target_type` and `target_id`. There is no list of every note in the workspace.
- `decisions_list` and `plan_items_list` work with or without a target. With no target, they list the whole workspace.
- An open plan item has status `todo` or `in_progress`.
- Pin a note only when it is a high-signal fact that every future reader must see first.

## Other records

| Record | Role |
| --- | --- |
| **Handbook page** | A nested markdown page: `title`, `slug`, `body`, `parent_id`. The slug stays the same when the title changes. Pages nest up to five levels. |
| **List** | A hand-picked set of records of one `target_type`. Use `list_members_add` and `list_members_remove`. Deleting a list does not delete its records. |
| **Form** / **Form submission** | A public inbound form. A submission can create or update a Person, Company, and Position, and can create a pipeline record. |

## What Kelpie does not have

Do not look for these, and do not put them in free text as a substitute:

- A job title field on Person.
- A "next step" text field on any record. Use a plan item.
- A "won" or "lost" field on a Deal. Use a closed stage.
- A favour ledger on Partnership.
- Email sending. Kelpie does not send email for you. Draft the text and give it to the user.
