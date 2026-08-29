# Forms

Embeddable forms for your website that write straight into the CRM: a submission creates or updates a person, their company, their position, and optionally a deal — no copy-paste from a contact inbox.

## What a form is

Forms are Kelpie's one public surface. Submissions arrive from strangers' browsers with no login, identified only by the form's public key. Everything else in Kelpie requires credentials.

## Building a form

A form's detail page has five tabs: **Submissions**, **Fields**, **Actions**, **Settings**, and **Embed**. The field builder supports text, email, textarea, and select fields, dragged into order. What a field *maps to* decides what a submission writes.

The builder is the one screen in Kelpie that saves explicitly rather than as you type — press Save when the field list is right. It refuses to save an invalid list and shows the reason beside the field responsible.

<!-- screenshot: form field builder -->

## Mapping fields to records

Nine targets:

| Target | Writes |
| --- | --- |
| Person · name | The person's name. |
| Person · email | The person's email. **Required on every form, at most once** — it is how the submitter is matched. |
| Company · name | The company's name. |
| Company · domain | The company's domain, and how an existing company is matched. |
| Position · title | The submitter's job title, stored on the person↔company link. |
| Deal · name | The deal's name, when the Deal trigger is on. |
| Opportunity · name | The opportunity's name, when the Opportunity trigger is on. |
| Partnership · name | The partnership's name, when the Partnership trigger is on. |
| Submission only | Stored with the submission and written to no record — right for "How can we help?". |

## What a submission creates

A submit matches the person by email and the company by domain, then by name. The merge **fills blanks and never overwrites**: an inbound "Alex" does not replace the "Alex Rivera" your team recorded, and a blank answer never erases a stored value. The one field always updated is last-contacted — filling in your form is the person being in touch.

**A company is never inferred from an email address.** Only an answer mapped to Company · domain sets one. Email domains are not company identifiers — one company sends from several, consumer addresses belong to none, and two unrelated people can share one — so inferring would quietly merge records that were never the same company. A form that wants companies matched by domain asks for the domain.

## Post-submit actions

The **Actions** tab is where you say what the form does with a submission beyond capturing it. All actions are optional and every control commits as you change it. If any action fails, the runner logs the failure to the submission's action log and keeps going — a broken action never loses the lead.

**Deal / Opportunity / Partnership triggers** sit side by side. (Before this release, the Deal trigger lived on Settings; it now sits with the other two, so the whole "what happens next?" story is on one screen.) For each: pick a stage (or let it default to the first open one), a name template that expands `{{company.name}}` and `{{person.name}}`, and — for Opportunity and Partnership — a kind and an owner. Deal and Partnership need a Company · name or Company · domain field on the form, because a deal and a partnership each belong to a company; Opportunity does not, because it may have none.

**Tag the person / tag the company** merge a list of tags into the captured records. The merge is a union: it never removes a tag anyone set by hand. Company tags are skipped when no company is resolved.

**Add to a list** feeds the submitter (for a person list) or the resolved company (for a company list) into an existing list. Deleting the list quietly drops the action from every form naming it — a list delete is never blocked by a form.

**Attach the submitter to a record** links every submitter into a pre-existing deal, opportunity, raise, or partnership through `person_links` — "everyone who fills this form joins the Q4 accelerator opportunity". Deleting the record drops the mapping.

Each configured action lands one entry on the submission's `action_log` — `ok`, `skipped` (the precondition was absent — a company tag on a submit that resolved no company), or `error` (something went wrong; the rest of the submit still ran). The Submissions tab shows the counts and the detail on hover.

## Embedding on your site

The Embed tab gives you the hosted page's URL and two snippets: a plain iframe (one tag, no JavaScript, fixed height) and an iframe with a small script that resizes the frame as the form grows and when the thank-you message replaces it. The embedded page is served by Kelpie itself and loads nothing else — it does not pull the CRM's code into your marketing site.

<!-- screenshot: embed tab -->

## Pausing, submissions, and privacy

- **Pausing** a form closes its submissions; the embedded page still renders and says the form is closed.
- The **Submissions** tab shows every answer and links to the records each submission created or matched.
- The public response a submitter's browser sees carries the thank-you message and nothing that identifies your CRM's contents — no record ids, so an outsider cannot probe whether somebody is already in your CRM.

## Limits

Public submissions are rate limited per visitor address — 20 per minute unless your operator tuned it ([Configuration](../self-hosting/configuration.md#rate-limits)). There is no CAPTCHA; the rate limit is the control.
