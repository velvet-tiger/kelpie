# Forms

Embeddable forms for your website that write straight into the CRM: a submission creates or updates a person, their company, their position, and optionally a deal — no copy-paste from a contact inbox.

## What a form is

Forms are Kelpie's one public surface. Submissions arrive from strangers' browsers with no login, identified only by the form's public key. Everything else in Kelpie requires credentials.

## Building a form

A form's detail page has five tabs: **Submissions**, **Fields**, **Actions**, **Settings**, and **Embed**. The field builder supports text, email, textarea, and select fields, dragged into order. What a field *maps to* decides what a submission writes. **Settings** holds the public form title (defaults to the form name; shown as the heading on the hosted/embedded page), thank-you copy, status, and the public key. The workspace name appears above that title on the public page.

The builder is the one screen in Kelpie that saves explicitly rather than as you type — press Save when the field list is right. It refuses to save an invalid list and shows the reason beside the field responsible.

<!-- screenshot: form field builder -->

## Mapping fields to records

Each field maps to an object and attribute via a searchable picker — not a fixed dropdown. The catalog includes every writable standard field on Person, Company, Position, Deal, Opportunity, Partnership, Enquiry, and Raise, plus your workspace custom fields (`Person · Budget (custom)`, etc.).

**Required:** one field must map to **Person · email** (at most once). It is how the submitter is matched.

**Repeatable:** **Submission only** and **Person · consent** may appear on more than one field.

**A consent the person already has stays as it is.** A ticked box writes a new grant only when the person has no record for that purpose. If the person already has one, granted or withdrawn, Kelpie does not change it: not its status, its date, or its source. A form needs no sign-in, so the submit does not prove who sent it. The person's timeline shows the attempt, and you can set the consent on the person record.

**When values land:** an answer is written only on a record that this submit creates. Person, Company, and Position answers are written when the submit creates that person, company, or position. Deal, Opportunity, Partnership, and Enquiry answers are written when the matching create trigger runs, because the trigger always creates a new record.

**A submit never changes a record that was already in your workspace.** Anybody can type an email address or a company name that matches one of your records, so a match is not proof. When the submit matches a person or a company, or the form attaches the submitter to a raise, none of the mapped answers are written on that record. This covers names, phones, addresses, summaries, tags from any field type, custom fields, a company's domain, and do not contact. The answers are not lost. The submission keeps every answer as it was typed. The action log has one `map_field:<target>` entry marked `skipped` with the reason "The record already existed" for each answer that differs from what the record holds. An answer that says what the record already says gets no entry, so a returning visitor who types the same name again adds nothing to the log. A value typed where the record has none does get an entry: that is the one worth a look. Copy a value to the record yourself when you trust it.

An answer is the same as the record when: text is equal after the spaces around it are removed (capital letters count, except in a company name, a job title, an email address and a domain); a phone is already on the person's list; every tag in the answer is already on the record; a yes or no is the stored one; an address part or a custom field has the same value.

**A value the field cannot hold is skipped.** A mapped answer gets the same check the API gives that field: its type, its length, its allowed values. An answer that fails the check is not written, for example words in a number field or a line of more than 500 characters in a one-line field. The submit still succeeds, the answer stays on the submission, and the action log has a `map_field:<target>` entry marked `skipped` with the reason. A record takes at most 100 tags of at most 120 characters each.

**Do not contact** can be set by a field mapped to Person · do not contact, on a person the submit creates. A submit never changes it on a person who was already in your workspace.

Common starters — Person · name, Company · domain, Position · title, Submission only — remain in the "Add field" menu for speed.

## What a submission creates

A submit matches the person by email and the company by domain, then by name. A new person or company gets the answers. A matched one is left as it is, and the submit only adds to it:

- a Position at the company, when a title was given and the person holds none there (a Position the person already holds keeps its title);
- the pipeline records, list memberships, and attached-record links the form is set up to make;
- the tags you set on the form's Actions tab (your own fixed tags, not the visitor's);
- a new consent grant, where the person had none for that purpose;
- the submission on the person's timeline, and the person's last-contacted time.

**A company is never inferred from an email address.** Only an answer mapped to Company · domain sets one. Email domains are not company identifiers — one company sends from several, consumer addresses belong to none, and two unrelated people can share one — so inferring would quietly merge records that were never the same company. A form that wants companies matched by domain asks for the domain.

## Post-submit actions

The **Actions** tab is where you say what the form does with a submission beyond capturing it. All actions are optional and every control commits as you change it. If any action fails, the runner logs the failure to the submission's action log and keeps going — a broken action never loses the lead.

**Deal / Opportunity / Partnership / Enquiry triggers** sit side by side. (Before this release, the Deal trigger lived on Settings; it now sits with the others, so the whole "what happens next?" story is on one screen.) For each: pick a stage (or let it default to the first open one), a name template that expands `{{company.name}}` and `{{person.name}}`, and — for Opportunity and Partnership — a kind and an owner. Enquiry takes an optional free-text Source (e.g. "Website contact"), written to the enquiry's `source` column; no kind requirement. Deal and Partnership need a Company · name or Company · domain field on the form, because a deal and a partnership each belong to a company; Opportunity and Enquiry do not, because their company is optional.

**Tag the person / tag the company** merge a list of tags into the captured records. The merge is a union: it never removes a tag anyone set by hand. Company tags are skipped when no company is resolved.

**Add to a list** feeds the submitter (for a person list) or the resolved company (for a company list) into an existing list. Deleting the list quietly drops the action from every form naming it — a list delete is never blocked by a form.

**Attach the submitter to a record** links every submitter into a pre-existing enquiry, deal, opportunity, raise, or partnership through `person_links` — "everyone who fills this form joins the Q4 accelerator opportunity". Deleting the record drops the mapping.

Each configured action lands one entry on the submission's `action_log` — `ok`, `skipped` (the precondition was absent — a company tag on a submit that resolved no company), or `error` (something went wrong; the rest of the submit still ran). A mapped value that was skipped has a `map_field:<target>` entry, and mapped values that could not be saved on a record have a `map_fields:<record type>` entry marked `error`. An email entry can also be `refused`: the mail server refused the email for good, for example because the mailbox does not exist, and Kelpie does not send it again. An email entry that is an `error` is tried again. The Submissions tab shows the counts and the detail on hover.

## Emails and their limits

**An auto-reply needs the spam check.** A form with the auto-reply on must have "Require the spam check" on. The builder turns the check on when you turn the auto-reply on, and the API answers `422` naming `auto_reply` and `require_spam_check` otherwise. A form saved before this rule keeps sending until you next save it. That save is refused until the check is on.

Two limits protect the mail your server sends. Each one skips the auto-reply, keeps the submission, and writes the reason on the submission's action log:

- one auto-reply per form per address in 24 hours;
- a daily number for the workspace (default 500).

A submit held as spam sends nothing and counts toward neither. The visitor is never told that a limit was reached.

## Embedding on your site

The Embed tab gives you the hosted page's URL (standalone page with workspace name and form title) and two iframe snippets that load a **bare** form document — fields only, no page chrome. Each snippet has a **Preview** that opens that bare embed in a modal; **Open** on the hosted URL loads the full page in a new tab. Both documents are served by Kelpie itself and load nothing else from your marketing site.

<!-- screenshot: embed tab -->

## Pausing, submissions, and privacy

- **Pausing** a form closes its submissions; the embedded page still renders and says the form is closed.
- The **Submissions** tab shows every answer and links to the records each submission created or matched.
- The public response a submitter's browser sees carries the thank-you message and nothing that identifies your CRM's contents — no record ids, so an outsider cannot probe whether somebody is already in your CRM.

## Limits

Public submissions are rate limited per visitor address — 20 per minute unless your operator tuned it ([Configuration](../self-hosting/configuration.md#rate-limits)). There is no CAPTCHA; the rate limit is the control.
