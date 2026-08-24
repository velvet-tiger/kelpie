# Kelpie documentation

Kelpie is an open-source CRM and company handbook that AI agents can operate: your team and your agents work on the same records through the same API. To get a Kelpie running, start with the [installation guide](self-hosting/installation.md) or the quickstart in the [project README](../README.md).

## Using Kelpie

For workspace members and admins.

- [Getting started](guides/getting-started.md) — first session: account, workspace, and a tour.
- [People, companies, and positions](guides/records.md) — the directory layer, search, and lists.
- [Pipelines and hiring](guides/pipelines.md) — deals, opportunities, fundraising, partnerships, roles and candidates.
- [Notes, plans, and decisions](guides/planning-and-decisions.md) — the memory layer and the dashboard.
- [Handbook](guides/handbook.md) — the markdown pages your team and your agents both read.
- [Forms](guides/forms.md) — public forms that write CRM records.
- [Import and export](guides/import-and-export.md) — CSV in and out, vendor presets, sample data.
- [Administration](guides/administration.md) — roles, team, settings, modules, keys.

## Running your own Kelpie

For self-host operators. (On the hosted cloud, none of this applies.)

- [Installation](self-hosting/installation.md) — `npm create kelpie` to a signed-in workspace.
- [Configuration](self-hosting/configuration.md) — every variable, in one place.
- [Production](self-hosting/production.md) — TLS, migrations, backups, upgrades, key rotation.
- [Security](self-hosting/security.md) — the security model on one page.

## Agents and the API

For people connecting agents or building integrations.

- [Connect an agent](agents/connect-an-agent.md) — point Claude, Cursor, or any MCP client at a workspace.
- [Agent tasks](agents/agent-tasks.md) — the built-in prompt recipes, Copy and Run.
- [API and webhooks](agents/api-and-webhooks.md) — calling the REST API and verifying webhook deliveries.
- [API reference](api-reference.md) — every endpoint, and what is not built yet.

## Extending Kelpie

- [Writing a module](extending/writing-a-module.md) — routes, tables, tools, events, and UI in your own module.

## Reference and contributing

- [API reference](api-reference.md) — endpoint-by-endpoint implementation status.
- [Development guide](development.md) — working on Kelpie itself.
- [Changelog](../CHANGELOG.md) — read before upgrading; 0.x minors may break.
- [Contributing](../CONTRIBUTING.md) — how contributions and copyright assignment work.
