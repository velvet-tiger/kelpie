# Writing a module

Extend a Kelpie install with your own module: routes, tables, MCP tools, events, and UI, all registered through the same runtime core's own features use — which is what keeps the extension points honest. This page is for building against the **published** `@kelpie/*` packages in your own assembly. Working inside the `kelpie-crm` repository itself is covered by the [development guide](../development.md).

## What a module can do

A server module contributes REST routes under `/v1`, MCP tools, database tables with their own migrations, typed domain events, configuration, and an email provider. A UI module contributes navigation items, whole pages, record tabs, and component overrides. Modules follow the same rules as core: routes are public API, tables carry the workspace id, and there are no private endpoints.

## Where a module lives

A module is an npm package (or a local file) added to your assembly's two lists: `kelpie.config.ts` for the server half, `kelpie.ui.config.ts` for the UI half. Install it, add it to the array, restart. Boot fails loudly on a duplicate id, an unmet dependency, or invalid module config — every failure names the module — rather than starting without it.

## A minimal server module

```ts
import type { KelpieModule } from '@kelpie/server'
import { z } from 'zod'

export const flags: KelpieModule = {
  id: 'feature-flags',
  requires: ['workspace'],

  async register(context) {
    const config = context.config(z.object({ FLAG_SERVICE_URL: z.string() }))

    context.routes((router) => {
      router.get('/flags/status', (c) => c.json({ host: config.FLAG_SERVICE_URL }))
    })
  },
}
```

- `id` must be unique across the assembly.
- `requires` names other module ids; registration order is resolved from it.
- `context.config(schema)` validates your environment variables at boot. A deployment can also lock any of them in code through the assembly's `env` section ([Configuration](../self-hosting/configuration.md#module-settings)).

## Route paths

Core checks the paths of a module when the server starts. A path that breaks a rule stops the boot. The error names the module and the path.

**The router from `context.routes`.** Core mounts every module router on `/v1`. A path that starts with a pattern matches the routes of other modules, and the switch of your module then applies to them.

- Start each path with a segment of plain text: letters, digits, `.`, `_`, `~` or `-`. `/flags`, `/flags/:id` and `/flags/*` pass. `*`, `/*`, `/:id` and `/:tenant/flags` fail.
- `/` passes. It is the one route at `/v1`.
- Give the path in each call. `router.get('/flags', list).post(create)` fails, because the second call has no path. Write `router.get('/flags', list).post('/flags', create)`.
- These rules apply to `get`, `post`, `put`, `patch`, `delete`, `options`, `all` and `on`. Each path in a list that you give to `on` must pass.

Core checks the router of a toggleable module. Keep to the same rules in a structural module.

**`context.appRoute` and `context.appMiddleware`.** These mount on the app, outside `/v1`.

- The path starts with `/` and then a segment of plain text, from the same characters. `/auth/:provider/callback` and `/operator/api/*` pass. `/`, `/*` and `/:name/login` fail.
- The first segment is not `v1`, `mcp` or `healthz`, in any letter case. Those paths are core's.

## Scopes for your routes

An API key can be limited to scopes. A scoped key reaches a `/v1` route only when a scope is declared for that route. Declare one for each route a scoped key may call:

```ts
context.routeScopes([
  { methods: ['GET'], path: '/flags/status', scope: 'workspace:read' },
  { methods: ['POST', 'PATCH'], path: '/flags/:id', scope: 'workspace:write' },
])
```

- `path` is the path you gave the router, so it is under `/v1`. A `:name` segment matches one path segment. A last segment of `*` matches the path before it and everything below (`/flags/*`). Any other pattern fails boot.
- `scope` is one of core's scopes. Use the scope of the data the route reads or changes (`'people:read'`), or an admin scope such as `'workspace:write'` for a route that manages your module. A module cannot add a scope name.
- A `GET` declaration covers `HEAD`.
- A route with no declaration answers `403` to every scoped key. A full-access key and a session still reach it. This is the default, so a route you forget is closed and not open.
- Core's rules are read first. A declaration for a core route changes nothing.

Routes from `publicRoutes` take no credentials and need no declaration. MCP tools declare their scope on the tool, as the next section shows.

## Tables and migrations

`context.schema(tables, migrationsDirectory)` registers your Drizzle tables and a migrations directory of your own. Each directory gets its own migrations tracking table, and your migrations run in the same pipeline as core's, in module registration order. Follow core's conventions: a `workspace_id` column on every table, indexes leading with it.

## MCP tools

`context.mcp.tool({ name, description, scope, inputSchema, invoke })` registers a tool. `scope` is the API key scope a bearer caller needs, the same one the matching REST route needs (`'people:read'`, `'forms:write'`). The runtime checks it on every call, over MCP and in-process, before it parses the arguments. Share the Zod schema between the tool and its REST route so the two cannot drift; `invoke` receives the parsed arguments and the authorized caller, and a validation failure answers exactly like the REST surface. A resource with the standard list/get/create/update/delete shape can register all five verbs at once with `registerCrudTools` from `@kelpie/server`; give it `scopes: { read, write, delete }`. An object-data resource names its own delete scope (`'people:delete'`); a resource with none names its write scope again.

`context.mcp.list()` returns every tool in the assembly, from every module. Call it at run time, not inside `register`: the list is complete only after boot. A module that acts through other modules' tools in-process, as the `ai` module does, reads it there.

## Agents a module runs

A module can register its own agent for the Run menu. Write a row to `agent_registrations` with `managed_by` set to the module's id, and call `context.agentDispatch.provide(dispatcher)` in `register`. Core then hands each run for that row to your dispatcher in-process, with the same payload it would POST to an HTTP agent, and records the outcome you return (`{ delivered, status, reason }`) on the run. Queue the work and return quickly, as an HTTP receiver would. Core refuses `PATCH` and `DELETE` on a managed row, and the MCP tab on Admin → AI links to its `settings_path`. The `ai` module is the example.

## Events

Modules publish and subscribe on a typed, in-process event bus. Your module declares its own event catalog (a Zod schema per event name, names shaped `<module>.<object>.<verb>`), and emits happen after the transaction commits. Handlers run async and must be idempotent — delivery is at-least-once with no durable queue.

Naming an event with a `created`, `updated`, or `deleted` verb and a record target makes it **webhook-deliverable automatically**: the bridge translates it to the matching `record.*` wire event. The four wire kinds (`record.created`, `record.updated`, `record.deleted`, `form.submitted`) are the current ceiling; a module cannot add a fifth wire kind yet.

## The UI half

```tsx
export const flagsUi: UiModule = {
  id: 'feature-flags',

  register(context) {
    context.nav('primary', { id: 'flags', label: 'Flags', to: '/flags', order: 250 })
    context.route({ path: '/flags', element: <FlagsPage /> })
    context.recordTab('company', { id: 'flags', label: 'Flags', render: (r) => <Tab id={r.recordId} /> })
  },
}
```

Nav slots are `primary`, `admin`, and `account`; there is also `auth.methods` on the signed-out pages, covered below.

Core numbers its own items in hundreds, so an `order` like 250 lands between core entries. Record tabs render on person, company, deal, opportunity, partnership, and raise detail pages. `context.adminTab('ai', tab)` adds a tab to Admin → AI, beside core's MCP tab; the `ai` module adds its Settings and Run log tabs this way. Its `?tab=` opens a tab by id. Component overrides go through typed tokens (`defineOverridable` / `context.override`), so an override with the wrong props is a compile error. Clashes — two modules claiming one id, or overriding the same component — fail the build rather than a browser.

Two registered slot kinds have **no render site yet**: record sidebar cards and dashboard cards. Contributions to them compile and register but draw nothing until core renders those slots.

## Toggleable or structural

A module is toggleable by default: the runtime declares a `module.<your-id>` capability for it, workspace admins can switch it off at Admin → Modules, and a disabled module answers "entitlement required" on its routes and tools rather than disappearing. You do nothing to opt in. Declare `structural: true` only when switching your module off would make the product incoherent — then it registers unconditionally and never appears as a switch.

## Email provider modules

`context.provideEmailSender(name, sender)` registers a named transactional-mail sender. The deployment picks one with `EMAIL_PROVIDER=<name>`; only the chosen provider's factory runs. Core ships `log` and `smtp`; a Resend or Postmark module follows the same shape under its own name.

A sender gets an `EmailMessage`. `to`, `subject` and `body` (the plaintext part) are always there. `html`, `replyTo`, `fromName` and `headers` are optional; send each one that is set. `headers` is a record of header name to value, for example `Auto-Submitted`. Core checks it before your sender gets the message: no line break or control character in a name or a value, and none of the headers the port owns (`From`, `To`, `Reply-To`, `Subject` and the like). Pass the record to your vendor's custom-headers option as it is. `EMAIL_FROM` is checked at boot: it is one address, or `Name <address>`.

When a send fails, throw. The emails are background jobs, and a job whose sender throws is retried three times in about four minutes. Some failures get the same answer on every try: the mailbox does not exist, the recipient's domain takes no mail, the vendor refuses the message for its content. For those, throw `PermanentEmailError` from `@kelpie/server`:

```ts
import { PermanentEmailError } from '@kelpie/server'

if (response.status === 422) {
  throw new PermanentEmailError(`Vendor refused ${message.to}: ${reason}`, { cause })
}

throw new Error(`Vendor send failed with ${response.status}`)
```

A job does not retry a `PermanentEmailError`. The form email job records the message as `refused`, with your error text, on the submission; the account and invitation jobs write it to the log, and the invitation job also puts your error text on the invitation, where the Team page shows it. Keep the text short and free of secrets: an admin reads it. Throw any other error for a failure a later try can clear: a timeout, a lost connection, a rate limit, a `5xx` from the vendor's API. If you are not sure, throw a plain `Error`: a retry that was not necessary costs little, and a message that is dropped is lost. Core recognises the error by its name, with `isPermanentEmailError`, so it also works when your module resolves its own copy of `@kelpie/server`. The built-in `smtp` provider throws it for a `5xx` SMTP answer to the sender, a recipient or the message, and for an address nodemailer refuses; a `4xx` answer, a timeout, and a connection, DNS, TLS or sign-in failure are plain errors.

## Email content

To send an email that looks like the emails core sends, build its two parts with the renderer that core uses. `renderEmail` and `renderTextEmail` are exports of `@kelpie/server`. Each takes an `EmailContent` (an optional `intro`, an optional `action` that becomes a button, and an optional `outro`) and the base URL of the deployment. Each gives back `text`, the plaintext part, and `html`. Give the two to `context.email.send` as `body` and `html`.

```ts
import { renderTextEmail } from '@kelpie/server'
import type { EmailSender } from '@kelpie/server'

async function sendReport(email: EmailSender, appBaseUrl: string, workspaceName: string, to: string): Promise<void> {
  const { text, html } = renderTextEmail(
    {
      intro: `The weekly report for ${workspaceName} is ready.`,
      action: {
        instructions: 'Read the report in Kelpie:',
        buttonText: 'Open report',
        link: new URL('/reports/weekly', appBaseUrl).toString(),
      },
      outro: 'You get this email because you are an admin of the workspace.',
    },
    appBaseUrl,
  )

  await email.send({ to, subject: `Weekly report for ${workspaceName}`, body: text, html })
}
```

Use `renderTextEmail` when a string holds text that a user typed, such as a workspace name or a person's name: it escapes every string for the HTML part. `renderEmail` puts its strings into the HTML as they are, so use it only for words you wrote. Neither function changes the subject. A subject is one line, so remove line breaks from user text before you put it there.

The optional third argument is the name in the header, "Kelpie" by default. The optional fourth argument is `'deployment'` (the default: the name in the header links to the deployment) or `'none'` (the name is text). Use `'none'` for a reader who cannot sign in. In the plaintext part, the link of the `action` is on a line of its own.

## CAPTCHA provider modules

`context.provideCaptcha(name, build)` registers a named CAPTCHA provider. The deployment picks one with `CAPTCHA_PROVIDER=<name>`; only the chosen provider's factory runs, so read your keys inside `build`. Core ships no provider, and with the variable unset nothing draws a CAPTCHA.

A provider is a `widget` and a `verify` function (`CaptchaProvider` in `@kelpie/server`). The widget names the vendor script, the global it defines, your public site key, and the origins the widget needs in a Content-Security-Policy. The form embed draws it with `window[globalName].render(element, { sitekey, callback })`, which is the shape Turnstile, hCaptcha and reCAPTCHA v2 share. `verify(response)` asks the vendor and answers `true` or `false`; throw when the vendor cannot be reached, and the forms module then lets the submit through.

```ts
context.provideCaptcha('turnstile', () => {
  const config = context.config(turnstileConfigSchema)

  return {
    widget: {
      scriptUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
      globalName: 'turnstile',
      siteKey: config.TURNSTILE_SITE_KEY,
      contentSecurityPolicy: {
        scriptSrc: ['https://challenges.cloudflare.com'],
        frameSrc: ['https://challenges.cloudflare.com'],
        connectSrc: ['https://challenges.cloudflare.com'],
      },
    },
    verify: (response) => verifyWithTurnstile(config.TURNSTILE_SECRET_KEY, response),
  }
})
```

## Sign-in providers

A module can sign a browser in with an identity it verified somewhere else. Core owns the account, the session, and the cookie; the module owns the protocol, and core never learns what OIDC or SAML is.

```ts
const identity = await verifyHowever(request)   // yours: OAuth, SAML, anything

await context.completeExternalSignIn(honoContext, {
  email: identity.email,
  emailVerified: identity.emailVerified,
  name: identity.name,
  verifiedBy: 'sign-in:google',      // recorded on the session
  provision: 'create',               // or 'refuse' for an unknown address
})
```

Core finds the account or provisions one, issues a session through the same code a password sign-in uses, and writes the cookie. It refuses an identity whose `emailVerified` is false, and throws `ExternalSignInError` (an `AppError`, so an uncaught one renders as the standard error body) with a `reason` of `email_unverified` or `unknown_identity`. Catch it if you would rather redirect somewhere useful than answer JSON.

Mount the redirect and the callback with `context.appRoute`, not `context.routes`: they are reached by a stranger's browser, and `/v1` puts an actor, a rate limit, and a `module.<id>` gate in front of them. Two things follow from owning a surface outside `/v1`. Your assembly must name your prefix in `serveWebBundle`'s `apiPrefixes`, or the SPA fallback answers your callback with the page shell. And its dev proxy needs the same prefix, or the browser never reaches the API at all.

The UI half contributes to `auth.methods`, which the sign-in and sign-up pages render:

```tsx
context.authMethod({
  id: 'sign-in',
  order: 100,
  render: ({ intent, next }) => <SignInButtons intent={intent} next={next} />,
})
```

`next` is the in-app path the reader was heading for, already checked against the open-redirect rule; carry it through your redirect so an invitee still lands on their invitation. Core draws nothing around what you return, so a module with buttons draws its own `AuthDivider`; both it and `AuthLinkButton` are exported from `@kelpie/ui`. Report a failed callback by redirecting to `/login?<your-param>=` and reading it in your own component: core has no vocabulary for your provider's errors.

## Developing against unreleased core

`npm link` a `kelpie-crm` checkout and run your assembly with `--conditions=kelpie-source` to get the edit-restart loop without publishing. The mechanics are in the [development guide](../development.md#packaging).

## Versioning

Pin `@kelpie/server` and `@kelpie/ui` at matching versions — they release together and a mismatched pair has no meaning. While the major version is 0, a minor bump may break the module API; read the [changelog](../../CHANGELOG.md) before updating.
