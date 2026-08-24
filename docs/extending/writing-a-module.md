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

## Tables and migrations

`context.schema(tables, migrationsDirectory)` registers your Drizzle tables and a migrations directory of your own. Each directory gets its own migrations tracking table, and your migrations run in the same pipeline as core's, in module registration order. Follow core's conventions: a `workspace_id` column on every table, indexes leading with it.

## MCP tools

`context.mcp.tool({ name, description, inputSchema, invoke })` registers a tool. Share the Zod schema between the tool and its REST route so the two cannot drift; `invoke` receives the parsed arguments and the authorized caller, and a validation failure answers exactly like the REST surface. A resource with the standard list/get/create/update/delete shape can register all five verbs at once with `registerCrudTools` from `@kelpie/server`.

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

Nav slots are `primary`, `admin`, and `account`; core numbers its own items in hundreds, so an `order` like 250 lands between core entries. Record tabs render on person, company, deal, opportunity, partnership, and raise detail pages. Component overrides go through typed tokens (`defineOverridable` / `context.override`), so an override with the wrong props is a compile error. Clashes — two modules claiming one id, or overriding the same component — fail the build rather than a browser.

Two registered slot kinds have **no render site yet**: record sidebar cards and dashboard cards. Contributions to them compile and register but draw nothing until core renders those slots.

## Toggleable or structural

A module is toggleable by default: the runtime declares a `module.<your-id>` capability for it, workspace admins can switch it off at Admin → Modules, and a disabled module answers "entitlement required" on its routes and tools rather than disappearing. You do nothing to opt in. Declare `structural: true` only when switching your module off would make the product incoherent — then it registers unconditionally and never appears as a switch.

## Email provider modules

`context.provideEmailSender(name, sender)` registers a named transactional-mail sender. The deployment picks one with `EMAIL_PROVIDER=<name>`; only the chosen provider's factory runs. Core ships `log` and `smtp`; a Resend or Postmark module follows the same shape under its own name.

## Developing against unreleased core

`npm link` a `kelpie-crm` checkout and run your assembly with `--conditions=kelpie-source` to get the edit-restart loop without publishing. The mechanics are in the [development guide](../development.md#packaging).

## Versioning

Pin `@kelpie/server` and `@kelpie/ui` at matching versions — they release together and a mismatched pair has no meaning. While the major version is 0, a minor bump may break the module API; read the [changelog](../../CHANGELOG.md) before updating.
