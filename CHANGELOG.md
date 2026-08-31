# Changelog

All notable changes to `@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`, and `create-kelpie`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

The packages share one version and release together. An assembly pins core, and a mismatched pair has no meaning. `create-kelpie` writes a project pinning core at its own version, so it moves with them. A release note that names no package applies to all of them.

While the major version is `0`, a minor bump may break the API.

## [Unreleased]

## [0.9.0] - 2026-08-31

### Added

- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — **Enquiry**, a
  new top-of-funnel pipeline object. Inbound requests (from a website form,
  an email, a referral) that may become a Deal once qualified. Fields:
  name, free-text `source` (like Opportunity's `kind`), optional company,
  optional owner, `converted_deal_id`, summary, tags, custom fields.
  Starter stages `new → in_progress → closed`; migration 0030 seeds them
  for every existing workspace as well as new ones. Full Opportunity
  parity: `/v1/enquiries` CRUD, MCP tools, kanban page + detail page +
  stage settings, notes / activities / decisions / plans / lists
  attachment, custom fields (seventh object type), search collection,
  dashboard pipeline counts, webhook `record.*` events, sample-data
  fixture. **Convert to Deal**: `POST /v1/enquiries/:id/convert` mints a
  Deal, copies name / company / owner / linked people to it, records
  `converted_deal_id`, and moves the enquiry to its first closed stage.
  409 on a second convert (existing deal id in `details`); 422 when the
  enquiry has no company (deals' `company_id` is `NOT NULL`); deleting the
  deal nulls the pointer and re-opens conversion. Also available as MCP
  tool `enquiries_convert_to_deal`. **Forms trigger**: a fourth create
  trigger — `create_enquiry`, optional `enquiry_source` (written to the
  enquiry's `source`; no kind requirement), `enquiry_stage_id`,
  `enquiry_name_template`, `enquiry_owner_id`. Company optional; a submit
  without a company creates the enquiry with `company_id` null. New
  `form_submissions.enquiry_id` (set-null) and `form.submitted` webhook
  payload gains `enquiry_id`. Six new agent-task catalog entries
  (`enquiry.triage`, `.propose_plan`, `.refresh_summary`, `.draft_reply`
  as primary; `.capture_decision`, `.log_transcript` as overflow). New id
  prefix `enq_`. Nav sits between Companies and Deals.
- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — custom fields
  (Phase 1). A workspace defines its own fields on the six taggable record
  types (Person, Company, Deal, Opportunity, Partnership, Raise) at
  Admin → Custom fields, and every record on those types carries a
  `custom_fields` object over the same REST and MCP surface the UI uses.
  Nine field types (`text`, `long_text`, `number`, `currency`, `date`,
  `checkbox`, `select`, `multi_select`, `url`), immutable `key` and `type`
  after create, hard delete strips values from every record in one
  transaction, no per-record webhook flood for the strip. `PATCH` on a
  record's `custom_fields` is a partial merge: sent keys change, `null`
  clears a key, an unknown key is `422` with
  `details[].field = custom_fields.<key>`, absent keys are left alone. Five
  new MCP tools (`custom_fields_list/get/create/update/delete`) and every
  existing record tool accepts `custom_fields` automatically. New id
  prefix `fld_`, new entitlement `custom_fields.limit` (unlimited in open
  source), admin-only writes, member-visible reads. Spec:
  [`docs/custom-fields.md`](../docs/custom-fields.md).
- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — structured name
  parts on Person: `salutation`, `first_name`, `last_name`, and `suffix`,
  all nullable, beside the existing required `name`. `name` stays the
  canonical display string that every list, picker, timeline and search hit
  shows; the parts are optional detail. Composition runs one way and only on
  the way in — `POST /v1/people` (and `people_create`) may send the parts
  and no `name`, and composes one from `first_name`, `last_name` and
  `suffix`; a body with neither a name nor a part is `422` naming `name`.
  Nothing ever splits a `name` into parts, and patching a part does not
  rename the record. `first_name` and `last_name` join `name` at weight `A`
  in the people `search_vector` and in the `?q=` filter, so a person is
  found by a surname they are not displayed under. Forms gain
  `person.first_name` and `person.last_name` map targets, each merging under
  the existing fill-a-blank rule. The People CSV gains all four columns and
  round-trips them; `name` is no longer a required column, replaced by a row
  rule accepting `name` or `first_name`/`last_name`, and the HubSpot and
  Salesforce packs map `First Name` and `Last Name`. Adds migration `0028`.
- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — one polymorphic
  `person_links` table folds `deal_people`, `partnership_people`, and
  `raise_people` into a single join; Opportunity gains `person_ids` on the
  wire and a Contacts section on its detail page. The person side keeps a
  real foreign key with restrict, so the database still blocks deleting a
  person who is on a deal, opportunity, raise, or partnership. Person delete
  responses name each pipeline the person is on, in `PIPELINE_KINDS` order.
  The person activity roll-up now covers all four kinds in one query. Adds
  migrations `0024` (create + backfill) and `0025` (drop the three joins).
- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — forms post-submit
  actions. A form's new **Actions** tab hosts three side-by-side create
  triggers (Deal, Opportunity, Partnership; the Deal trigger moved off
  Settings for parity), person and company tag merges, list memberships, and
  attach-to-existing-record links via `person_links`. The public submit is
  now core capture plus per-action savepoints: an action that fails logs
  `{action, status, detail}` to the new `form_submissions.action_log` and
  the runner continues, so a broken action never loses the lead or the
  visitor's `201`. `form.submitted` webhooks carry `opportunity_id`,
  `partnership_id`, and one status per action. Adds migration `0026`.

### Changed

- **`@kelpie/schemas`** — `Form`, `FormInput`, and `CreateFormInput` gain
  the twelve new form settings (opportunity trigger, partnership trigger,
  person/company tags, list ids, attach targets); `FormSubmission` gains
  `opportunityId`, `partnershipId`, and `actionLog`; `Opportunity` gains
  `personIds`. All additions are backwards-compatible: a newer schema
  against an older server would reject a response missing the new fields,
  so publish the packages together.
- **`@kelpie/schemas`** — `FORM_FIELD_MAP_TARGETS` gains `opportunity.name`
  and `partnership.name`. The `form_fields.map_to` check constraint moves
  with them.

## [0.8.0] - 2026-08-28

### Added

- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — typed record lists.
  A list holds records of one type, chosen at creation and fixed for its
  lifetime; the type is enforced in the database through a composite foreign
  key from `list_members(list_id, target_type)` to `lists(id, target_type)`,
  so a person cannot end up on a company list even through direct SQL. A
  Lists tab appears on Person, Company, Deal, Opportunity, Partnership, and
  Raise detail pages, backed by `GET /v1/list-memberships`. The picker
  filters lists to the record's own `target_type`. MCP mirrors the REST
  surface. Adds migration `0021`.
- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — a `sample-data`
  core module. A one-shot installer seeds a fresh workspace with a small
  CRM fixture: companies, people, positions, deals, opportunities,
  fundraising, partnerships, hiring roles, candidates, plan items and notes.
  A checkbox on the setup wizard's workspace step and a button on the admin
  Data page both call it, and the new `sample_data_install` MCP tool exposes
  the same operation. Idempotent by refusal: a workspace that already
  carries any companies or people answers 409.
- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — a Columns picker on
  every list page. Every field in the resource catalog is available; every
  visible column is click-to-sort. Server-side sort fires when the
  resource's `_SORTS` map accepts the field; anything else reorders the
  loaded rows in place with a "sorted on this page" hint. Column choices
  persist on `user_preferences.list_views`, so they follow the person
  between browsers. Adds migration `0022`.
- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — pipeline pages
  persist mode, scope, grouping, and sort per user. `ListViewPreference`
  gains four optional fields alongside `columns`; the server accepts them
  through the same `list_views` endpoint. Deals, Opportunities, Fundraising,
  and Partnerships default to the board on a first visit.
- **`@kelpie/server`, `@kelpie/ui`** — email-domain auto-linking. When a
  Person or Company arrives with a matching non-consumer email domain, a
  titleless Position joins the pair inline in the same transaction. The
  response already reflects the link. Add-only.
- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — an `is_own` flag on
  companies for marking the workspace's own organisation, with a matching
  `?is_own=true|false` filter and a section on Admin → Workspace for picking
  existing companies to mark or creating one inline. Zero or many rows may
  carry the flag — parent + subsidiary is a supported case. Adds migration
  `0023`.
- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — `POST
  /v1/workspaces/:id/relink-email-domains` sweeps every Company that
  carries a domain and stubs Positions where none exists yet, so records
  that predate the auto-linker (or arrive through a bulk import) get their
  links backfilled. Add-only, consumer-host-skipping, idempotent, one
  transaction per Company. Wired to a "Rebuild links" button on Admin →
  Import & export.
- **`@kelpie/ui`** — an "Add plan item" form on the Planning page. The
  workspace-wide plan is the same resource each record's Plan panel edits,
  so create belongs here too. Picks target type, target record, date,
  title, owner, and status; owner defaults to unassigned. Refactors the
  target-name lookup out of `useTargetNames` into `usePipelineTargets` so
  one set of fetches drives both the form's target dropdown and the list's
  name resolution.
- **`@kelpie/ui`** — every list surface now shows one server page at a time
  with Prev / Next / a `Page N` label / a per-page selector (25 / 50 /
  100 / 200), mirrored above the rows. `RecordListResult` swaps
  `hasMore` / `loadMore` for `pageIndex` / `pageSize` / `hasPrev` /
  `hasNext` / `prevPage` / `nextPage` / `setPageSize`; a shared
  `usePagedList` drives the state and keeps every visited page in the
  `useInfiniteQuery` cache, so Prev is instant and Next fires one fetch
  only for pages not yet seen. A new `Paginator` component takes a
  `placement` prop for the top or bottom copy. Non-paginated directory
  helpers switched from `hasMore` to `hasNext` with the same meaning.
- **`@kelpie/ui`** — `EntitySearch` remembers the last-picked option so the
  badge stays visible even when clearing the query drops the pick from the
  current results. `CompanyDetail` moves People from the sidebar into a tab,
  styled to match Notes and Decisions.
- **`@kelpie/server`** — transactional mail now carries an HTML part. A new
  `renderEmail` in `lib/emailContent.ts` renders each message with
  [mailgen](https://github.com/eladnava/mailgen): a table-based responsive
  layout with the action as a button and the raw link kept as a fallback.
  The plaintext part is unchanged, built from the same fields, and remains
  the `body` every provider already receives. `EmailMessage` gains an
  optional `html` field and the `smtp-email` module passes it through to
  nodemailer; provider modules written against the older port keep working.
- **`@kelpie/ui`** — the CSV import wizard has a new `Done` step. After a
  commit reaches `completed` (or `failed`), the wizard moves off the dry-run
  view and shows an outcome summary: the number of rows written, the final
  counts, and the row errors and warnings the commit reported. An `Import
  another` button resets the wizard.
- **`create-kelpie`** — user documentation. Sixteen pages under `docs/`: an
  index, eight product guides, four self-hosting pages (installation,
  configuration, production, security), three agent and API pages, and a
  module-authoring guide. Linked from the root README and the scaffolder's
  template README. The template's configuration table gains the missing
  `TRUSTED_PROXY_HOP_COUNT` row.

### Changed

- **`@kelpie/server`** — `POST` and `PATCH /v1/positions` accept an empty
  title, for a link where the role is not yet known. Both add forms drop
  `required`.
- **`@kelpie/ui`** — `CompaniesPage` defaults visible columns to Name,
  Domain, HQ, Type, Updated.
- **`@kelpie/schemas`** — `domain` is no longer a required column for a
  Companies import. The database column is nullable, and rows without a
  domain now import when the match key is `name`. When `domain` is the match
  key, blank-domain rows still fail as `Missing required field`, because a
  match key must be non-empty.

### Fixed

- **`@kelpie/ui`** — inactive nav and secondary copy were hard to read on
  light surfaces. Darken the light-theme muted tokens for contrast.
- **`@kelpie/ui`** — the CSV drop zone on `/admin/data` now accepts a file
  dropped onto it. The label was styled as a drop zone but only its hidden
  file input handled the file, so a drop fell through to the browser
  default. Drop and click-to-browse now share one processing path.

## [0.7.0] - 2026-08-23

### Added

- **`@kelpie/server`, `create-kelpie`** — a standalone `migrate` command. Until
  now migrations ran only as a boot side effect, and `--no-migrate` turned that
  off with nothing to take its place, so a multi-instance deploy had no way to
  apply them. `npm run migrate` (root `db:migrate` in the monorepo) now registers
  the modules and applies every pending migration once, then exits. It is
  forward-only and safe to re-run. A new `bootAssembly` export owns the shared
  prelude, so the server entry point and the command register the same modules
  and cannot drift. Scaffolded projects get the command and its entry point.
- **`@kelpie/schemas`, `@kelpie/server`** — an `attio` import source. The import
  wizard offers an "Attio CSV pack" that maps an Attio Companies or People CSV
  export onto Kelpie's native columns with no hand mapping. An Attio People row
  links its company by name, and the export carries a job title for almost no
  rows, so a Position forms only where a title is present. Attio Deals and
  Positions still use `custom`.
- **`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`** — a People CSV import
  can now drive a Position. A row carrying `company_domain` or `company_name`
  and a `title` upserts the person and a Position on them, matching the company
  by domain first and by name second. An update-mode re-import renames the
  Position in place rather than adding a second one. A new `on_missing_company`
  job option chooses between `skip` (import the person, log a warning) and
  `create` (invent the company). Warnings are a new job field, shown row by
  row in the admin wizard alongside errors. HubSpot and Salesforce contact
  export column names auto-map. Adds migration `0019` for the new columns.
- **`@kelpie/server`, `@kelpie/ui`** — a non-production install now paints a
  thin strip above the shell naming itself, so three installs open side by
  side in one browser (dev, demo, cloud) no longer look identical. A new
  `KelpieConfig.siteName` reads `KELPIE_SITE_NAME`, and `GET /v1/public/config`
  reports the runtime mode and site name. The UI reads it once at boot. The
  strip hides in `production`, and the mode name is the label when `siteName`
  is unset.

### Fixed

- **`@kelpie/server`** — event subscribers in a consumer assembly now get a
  typed `event.data`. Each module augments `KelpieEventMap` through a relative
  `declare module`, which merged inside the monorepo but not for a project that
  installs the package and typechecks against `dist`: `index.d.ts` referenced
  none of the per-module `events.d.ts` files, so the augmentations never loaded
  and every `event.data` fell back to `unknown`. The entry point now references
  each catalog, so `context.events.subscribe('workspace.member.removed', ...)`
  and every other handler read their payload without a cast. No runtime change.

## [0.6.0] - 2026-08-23

### Added

- **`@kelpie/server`** — a named-provider registry for transactional mail.
  Modules call `context.provideEmailSender(name, sender)` to register; the
  assembly's `email.provider` picks one at boot. `'log'` is a built-in the
  runtime always registers, so a bare install boots. Multiple provider
  modules coexist safely; two modules registering the same name fails boot,
  and a config name nothing registered fails boot with the list of available
  names. `context.email` is unchanged for consumer modules — it is a proxy
  the runtime points at whichever provider `email.provider` picked. Provider
  transport is arbitrary: SMTP, a REST API (Resend, Postmark, SES), a log,
  all fit.
- **`@kelpie/server`** — a built-in `smtp-email` core module, part of
  `coreModules`. Registers a `'smtp'` provider that reads `EMAIL_FROM` and
  the `SMTP_*` variables through the module runtime, builds a nodemailer
  transport, and sends transactional mail (invites, password resets,
  verifications) over SMTP. Selected by setting `EMAIL_PROVIDER=smtp`. Ships
  the helpers `createSmtpEmailModule`, `createSmtpEmailSender`, and
  `SMTP_EMAIL_PROVIDER` for assemblies and tests that build their own
  transport.
- **`@kelpie/schemas`, `@kelpie/server`** — a per-module event bus. Every
  module publishes typed events (`people.person.created`,
  `deals.deal.stage_changed`, `workspace.member.joined`, and so on) on a
  shared `KelpieEvent<Name, Data>` envelope. A module declares its
  Zod-validated catalog through `KelpieModule.events`; `registerModules`
  merges every catalog before any module registers and fails boot on a
  duplicate event name. `runtime/events.ts` exposes `subscribe`,
  `subscribePrefix`, `publish`, and `registerCatalog`, and guards against an
  event handler that re-triggers its own event: a depth cap
  (`KELPIE_EVENT_MAX_DEPTH`) plus a repeat check stop the loop rather than
  letting it run until the stack overflows. The webhooks engine now
  subscribes to the whole bus and translates deliverable events into the
  same `record.created` / `record.updated` / `record.deleted` /
  `form.submitted` wire payloads as before; nothing on that wire contract
  changed.
- **`@kelpie/server`** — `runReseal(options)`, `ResealPass`, and
  `RunResealOptions` are now exported. `runReseal` was duplicated between
  `apps/kelpie/src/reseal.ts` and the `create-kelpie` template; both now call
  the shared implementation, which takes an `extraPasses` list so any
  assembly, including the cloud one, can plug in a reseal pass over its own
  sealed columns.
- **`@kelpie/server`** — `defineKelpieConfig()` and `fromEnv()`, the shape a
  `kelpie.config.ts` file now uses to declare the full core config. Every
  leaf is either a literal committed to git or a
  `fromEnv('KEY', schema, default)` marker the deployment fills in;
  `resolveKelpieConfig(config, process.env)` resolves the markers and
  returns the typed `KelpieConfig`. `KelpieConfigInput` also gains an
  optional `env` section, letting `kelpie.config.ts` lock or pass through
  arbitrary module environment keys, and optional `appBaseUrl` /
  `secretEncryption` fields so `APP_BASE_URL` and `SECRET_ENCRYPTION_KEY` can
  live in the config file instead of only in `process.env`. `loadConfig(env)`
  and a module's own `context.config(schema)` read both keep working, so an
  assembly that has not adopted the new file still boots.
- **`@kelpie/schemas`, `@kelpie/server`** — the agent-task resolve response
  and every dispatch payload now carry `base_prompt` alongside the existing
  `prompt`. `prompt` is unchanged: the external-agent-framed text the Copy
  button and existing agent registrations already expect. `base_prompt` is
  the same request without that framing, for a receiver that returns
  structured data for a caller to apply instead of running its own tool
  loop. `ResolvedAgentTask.basePrompt` falls back to `prompt` when parsing an
  older server's response, so a new client still works against a server that
  has not upgraded yet.

### Changed

- **Breaking, `@kelpie/server`** — `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
  `SMTP_USER`, and `SMTP_PASSWORD` no longer live in core's environment
  schema and `KelpieConfigInput.email.smtp` is removed. `EMAIL_PROVIDER` stays
  but is now a free-string that names an entry in the runtime's provider
  registry, not a fixed `'log' | 'smtp'` union. `EMAIL_PROVIDER=smtp` still
  works with no extra install because the built-in `smtp-email` core module
  registers it. `createEmailSender` is removed; assemblies no longer build a
  sender themselves — pass `email: { provider, from }` to `registerModules`
  and it resolves.
- **Breaking, `@kelpie/server`** — `ModuleServices.email` is removed. The
  runtime owns the email sender and exposes it as `context.email` on every
  `ModuleContext`. Assemblies drop the `email` field from their `services:`
  object.
- **Breaking, `@kelpie/server`** — `KelpieConfig` replaces the top-level
  `logLevel` field with a `logging: { level, destinations }` sub-tree. The
  logger delegates level filtering and transport fan-out to Winston; the
  JSON line it writes (`time`, `level`, `message` last) is unchanged. Stdout
  stays the only destination today, declared as `{ kind: 'stdout' }`. A
  self-hosted deployment that wants a second destination extends the
  `LoggingDestination` union in `@kelpie/server` and adds a matching entry to
  `logging.destinations` in its `kelpie.config.ts`.
- **Breaking, `@kelpie/server`** — `DOMAIN_EVENT_NAMES`, `DomainEventName`,
  `DomainEvents`, and `StagedObjectType` are removed, along with the legacy
  `subscribe(name, payload)` / `publish(name, payload)` overloads and the
  `envelope:` internal channel prefix. They are replaced by the event bus
  described above; a module or assembly that imported these types moves to
  `subscribe`, `subscribePrefix`, `publish`, `EventBus`, `EventCatalog`, and
  `KelpieEventMap`. Nothing on the public webhook wire payloads changed.

### Notes

- `.env.example` now names, for every variable, either the `kelpie.config.ts`
  field that reads it or the module and schema that does. It also documents
  `WEB_BUNDLE_DIR`, which was previously missing.

## [0.5.2] - 2026-08-17

### Fixed

- **`@kelpie/server`** — the `workspace.access` gate (0.5.1) now exempts
  `DELETE /v1/workspaces/:id`. Without this, a suspended workspace's owner
  got a `403` trying to delete their own workspace, with no way out of it
  until an operator reactivated it first. Every other verb and every
  sub-resource under `/v1/workspaces/:id` stays gated.

## [0.5.1] - 2026-08-17

### Added

- **`@kelpie/server`** — a new `workspace.access` flag capability, checked
  once per request by a blanket `/v1` and `/mcp` middleware. `/v1/auth/*`
  and the workspace-switch endpoint are exempt, so a member can still see
  why they are locked out or switch to a different workspace. No grant
  provider answers this capability in a self-hosted assembly, so
  `EntitlementRegistry`'s open-source default applies and nothing changes
  for anyone without a module that supplies one. Built for the cloud
  assembly's operator module, which can now enforce a real workspace
  suspension instead of only recording one in its own tables.

## [0.5.0] - 2026-08-15

### Changed

- **Breaking, `@kelpie/server` and `@kelpie/schemas`** — the server builds
  every emailed link (verification, password reset, invitation) itself from a
  new required `APP_BASE_URL` variable. The `verify_url_template`,
  `reset_url_template`, and `invite_url_template` request fields are removed
  from the wire schemas, the routes, and the MCP invite tool; sending one now
  answers `422`. Taking the link target from the request let an
  unauthenticated caller point a genuine Kelpie email at their own host,
  which is an account-takeover path. Every deployment must set
  `APP_BASE_URL` before upgrading; boot refuses to start without it.
- **Breaking, `@kelpie/server`** — a public form submit no longer returns the
  upserted person and company ids. A Kelpie id is a ULID whose timestamp let
  an anonymous caller tell a pre-existing contact from a new one. The public
  response carries the submission id and the thank-you copy; the stored
  submission, read over the authenticated API, still holds the record ids.

### Added

- **`@kelpie/server`** — modules can declare routes and middleware on the app
  itself, outside `/v1`: `ModuleContext.appRoute(method, path, handler)` and
  `ModuleContext.appMiddleware(pattern, handler)`. Declarations carry their
  real, full paths; `createApp` applies every declared middleware, then every
  declared route, so a pattern covers matching routes from every module. No
  actor resolution, workspace scoping, or `module.<id>` gate applies: a
  surface declared this way owns its own access rules. Paths at or under
  `/v1`, `/mcp`, or `/healthz` are refused at boot. Built for the cloud
  assembly's operator surface, which lives entirely in its own module.
- **`@kelpie/server`** — `serveWebBundle` takes `apiPrefixes`, extra prefixes
  the SPA fallback must leave to the API, for assemblies whose modules answer
  outside `/v1`.

### Security

- Login attempts are now also budgeted per account, keyed on the normalised
  email, so credential stuffing spread across many IPs is capped for the
  targeted address. A new optional `TRUSTED_PROXY_HOP_COUNT` reads the real
  client IP from `X-Forwarded-For` up to the deployment's trusted hops;
  without it, every caller behind a proxy shared one rate-limit bucket. The
  verify-email confirm and public form embed endpoints are now metered.
- An optional egress guard (`BLOCK_PRIVATE_EGRESS=true`) refuses webhook and
  agent-task deliveries to private, loopback, link-local, and reserved
  addresses, closing the SSRF path from customer-supplied endpoints to
  cloud metadata services and internal hosts. Off by default: a self-hosted
  Kelpie legitimately posts to internal automation. A blocked target records
  a failed delivery rather than crashing, and redirects stay closed.
- The public form routes now honour the `module.forms` entitlement, so a
  workspace that switched the module off no longer accepts submissions or
  serves the embed.
- Cross-module CRM queries carry explicit workspace predicates as defence in
  depth; they previously relied on record-id uniqueness alone.
- The session cookie's `Secure` flag is set outside development, not only in
  production.

### Fixed

- The idempotency middleware no longer resolves an actor on unauthenticated
  auth endpoints: `POST /v1/auth/login` or `/signup` with an
  `Idempotency-Key` header answered `401` before the handler ran.

### Notes

- Between 0.4.1 and this release, main briefly carried an operator-specific
  surface in core (`SUPERUSER_EMAILS`, a superuser guard, a fixed
  `/operator/api` mount). It was reworked into the generic declarations above
  before any release; no published package ever contained it. The cloud
  assembly's `operator` module now owns all of it.

## [0.4.1] - 2026-08-12

### Added

- **`@kelpie/server`** — `EMAIL_PROVIDER=smtp`, backed by `nodemailer`, behind
  the existing `EmailSender` port. `log` was the only option core shipped, so
  a self-hosted install had no way to actually deliver an invite or a
  password reset. `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, and
  `SMTP_PASSWORD` are required only when `EMAIL_PROVIDER=smtp`, matching the
  config layer's no-defaults rule.
- **`create-kelpie`** — the scaffolded `.env` and README document the new
  provider and its variables, and no longer state that Kelpie cannot send
  email at all.

### Notes

- A vendor-managed provider (Resend, Postmark, Mailtrap, SendGrid) needs an
  account core does not manage, so it belongs in a module rather than this
  switch, per `modules.md`'s split test.

## [0.4.0] - 2026-08-12

### Removed

- **`@kelpie/server`, `@kelpie/ui`** — the integration framework is now cloud,
  not core. Integrations need vendor accounts the cloud manages, and a
  self-hosted CRM is not broken without a catalog page listing providers it
  cannot connect to, so core no longer carries the half it had. `modules.md`
  records the change.

  Gone from `@kelpie/server`: the `integration_connections` table, its
  `integrations` module, and the `integrationConnection` id prefix. Gone from
  `@kelpie/ui`: `IntegrationProvider`, `IntegrationCategory`,
  `INTEGRATION_CATEGORIES`, `useIntegrationProviders`, the
  `integrationProvider()` contribution method, and `integrationProviders()` on
  `UiExtensions`.

  Migration `0017` drops the table. Nothing ever wrote to it, in core or
  anywhere else, so no data is lost. A module contributing a provider catalog
  now owns the descriptor type as well, which is where it belonged.

### Fixed

- **`@kelpie/ui`** — the `nav.account` slot rendered nowhere. `Shell.tsx` reads
  `primary` and `admin` and never read `account`, so a module contributing an
  account tab got a page with nothing anywhere pointing at it. `AccountLayout`
  now merges the slot into its tab strip, and core numbers its own three tabs in
  hundreds so a module can land between them. Present since the registry landed.
- **`@kelpie/ui`** — a module route under `account/` now renders inside
  `AccountLayout` rather than as a sibling of it, so it keeps the account tab
  strip instead of losing it the moment its own tab is clicked. Routes outside
  that prefix mount under the shell exactly as before.
- **`@kelpie/ui`** — the shell's sidebar and the account tab strip now share one
  rule for hiding the nav items of a disabled module, `useVisibleNavItems`. The
  filter previously lived in `Shell.tsx` alone, so the new account tabs would
  have kept showing a module the workspace had switched off, leading to a page
  that answers `403`.

## [0.3.1] - 2026-08-11

### Changed

- **`@kelpie/server`, `@kelpie/ui`** — optional properties that accept
  `undefined` now say so, as `prop?: T | undefined`. This affects
  `ModuleRuntimeOptions`, `UpdateWorkspaceInput`, the UI's list filter types, and
  the shared component props. Passing `undefined` where the value was previously
  only allowed to be absent now compiles, which is what an assembly building
  options from `readModuleConfigFile` was already doing. Nothing narrows, so no
  existing call breaks.

### Fixed

- **`create-kelpie`** — a scaffolded project failed its own `npm run typecheck`.
  The generated `tsconfig.server.json` sets `exactOptionalPropertyTypes`, under
  which passing `moduleConfig: undefined` is not the same as omitting the key.
  Present since `0.2.0`.
- **`create-kelpie`** — a scaffolded `vite build` demanded `API_PORT`, which only
  the dev server's proxy uses. Any build without a `.env` beside it failed, which
  is every container build, since the image leaves `.env` out. Present since
  `0.2.0`.

## [0.3.0] - 2026-08-11

### Added

- **`@kelpie/server`** — `serveWebBundle(app, { directory })`, which serves a
  built web bundle from the same origin as the API. Nothing did this before:
  `createApp` answers `/v1`, `/v1/public`, `/mcp` and `/healthz` and serves no
  pages, so a deployed assembly answered API calls and showed a blank page to
  every browser. The Vite dev server was hiding it, because it builds the pages
  and proxies the API in one tool, and only the first of those two jobs is
  development-only.
- **`@kelpie/server`** — `WEB_BUNDLE_DIR`, optional. Set it to the built bundle
  and one process serves the pages and the API. Leave it unset in development.
  Boot fails when it names a directory holding no `index.html`, so a deployment
  whose build did not run stops rather than serving invisible pages.
- **`create-kelpie`** — the generated entry point calls `serveWebBundle`, and
  the generated README has a Deploying section covering the production build and
  `--no-migrate` for more than one instance.

### Notes

- Upgrading is `npm update`. Nothing changes for an assembly that does not set
  `WEB_BUNDLE_DIR`, which includes every development setup.
- A deep link such as `/people/per_01J…` answers with `index.html`, because the
  app decides what to draw from the address. Unknown paths under `/v1`, `/mcp`
  and `/healthz` are left to the API, so a misspelled endpoint is still a JSON
  error rather than a web page with a 200.
- `@hono/node-server` is now a dependency of `@kelpie/server` rather than only
  of the assemblies. It supplies the static file middleware.
- `npm run verify:packaging` gained a fifth check: it restarts the scaffolded
  service with no dev server in front of it and asserts the API serves what it
  built. The four checks before it all passed while this was broken.

## [0.2.0] - 2026-08-10

### Added

- **`create-kelpie`** — `npm create kelpie@latest` scaffolds a self-hosted
  install: two module lists, two entry points, a Vite config, and a `.env` with
  an encryption key generated for that project. `@kelpie/server` and
  `@kelpie/ui` arrive as ordinary dependencies, so there is nothing to clone and
  upgrading is `npm update`. Prompts for what it cannot infer, and takes flags
  for every answer so it runs unattended.

### Notes

- Upgrading from `0.1.0` is `npm update`. There are no API changes in the three
  core packages; this release exists to publish the scaffolder alongside them.
- `0.1.1` was tagged in the repository and never published, so npm goes from
  `0.1.0` straight to `0.2.0`.

## [0.1.1] - 2026-08-10

Tagged, never published. No code differences from `0.1.0`. It was cut on a
mistaken reading of a `403 You cannot publish over the previously published
versions: 0.1.0`, which means the version was already published rather than that
it needed replacing.

## [0.1.0] - 2026-08-10

First public release.

### Added

- **`@kelpie/schemas`** — the wire contract for `/v1` as Zod schemas. One definition of what the API sends and accepts, shared by the service, the UI, and any agent decoding a response. Depends on Zod and nothing else.
- **`@kelpie/server`** — the service as a library. Module runtime, typed event bus, entitlements, and the core CRM modules: people, companies, positions, notes, activities, deals, opportunities, partnerships, raises, hiring, plans, decisions, handbook, search, dashboard, forms, import and export, agent tasks, webhooks, integrations, auth, API keys, and workspace administration. Ships its own migrations and applies them per module at boot.
- **`@kelpie/server/testing`** — the harness the core suite uses: app factory, database helpers, workspace fixtures, and a typed request client, so a module's tests can use the same tools.
- **`@kelpie/ui`** — React 19 components, pages, typed API client, and the extension registry an assembly composes modules through. Talks to the same public API agents use.
- MCP over Streamable HTTP on the same service, exposing the REST surface as tools.
- A packaging check, `npm run verify:packaging`, that installs the built tarballs outside the workspace and exercises them. In-workspace resolution always succeeds, so nothing else catches a broken package.

### Notes

- Requires Node 24 or newer and Postgres.
- `react` and `react-dom` are peer dependencies of `@kelpie/ui`.
- The packages export their TypeScript source under a `kelpie-source` condition and their compiled JavaScript under the default one. Consumers get JavaScript; the condition exists so the repository can develop without a build step. It is not part of the public contract.

[0.6.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.6.0
[0.4.1]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.4.1
[0.4.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.4.0
[0.3.1]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.3.1
[0.3.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.3.0
[0.2.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.2.0
[0.1.1]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.1.1
[0.1.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.1.0
