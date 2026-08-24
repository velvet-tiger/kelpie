# Administration

The owner's and admin's handbook: roles, team, workspace settings, modules, keys, and your own account.

## Roles

Three roles, enforced by the service rather than hidden buttons — a member who tries an admin action anyway is refused with a clear error.

| Role | Can |
| --- | --- |
| **Member** | Work with every CRM record, the handbook, planning, decisions, lists, and run agent tasks. |
| **Admin** | Everything a member can, plus the Admin pages: workspace settings, team, data import/export and sample data, API keys, webhooks, MCP agent registrations, and modules. |
| **Owner** | Everything an admin can, plus deleting the workspace and handing over ownership. Exactly one per workspace. |

Two edges worth knowing: **webhooks are admin-only even to read**, because a webhook URL routinely carries a credential in its path, so listing them would disclose secrets rather than settings. And there is no read-only role today — every CRM record is open to every member.

## Managing the team

**Admin → Team** invites by email (admin or member), changes roles, and removes people.

- Resending an invitation issues a new link and retires the old one; revoking deletes the invitation, which is what actually kills the link already in somebody's inbox. Stale invitations read as expired on their own.
- Inviting an address that already belongs to a member, or already holds a live invitation, is refused rather than doubled.
- Removing somebody who still owns records — deals, plans, decisions, notes, and the like — is refused with a list of what and how many. Reassign their records first.
- Ownership moves only by being given away, and the outgoing owner becomes an admin in the same step. The owner cannot be demoted or removed by anyone else.

<!-- screenshot: team page -->

## Workspace settings

Name, slug (a duplicate is refused), and timezone — which defines "today" for every overdue calculation in the workspace.

Two fields exist purely for agents: **tagline**, the short line an agent loads first, and **one-liner**, what the company does. Clearing either leaves it genuinely empty rather than storing an empty string. Fill both in; they are cheap context every agent task benefits from.

## Modules

**Admin → Modules** switches optional parts of Kelpie on or off for this workspace — hiring, fundraising, forms, webhooks, and the rest. The essential modules (people, companies, search, and so on) are always on and do not appear as switches.

Switching a module off is real, not cosmetic: its API operations and agent tools refuse with "entitlement required", so an agent cannot use a feature the workspace turned off just because it is not in the menu. If your operator locked a module for the whole deployment, it shows greyed out rather than hidden, so you can see the choice exists and is not yours.

<!-- screenshot: modules page -->

## API keys

Two kinds, managed in two places:

- **Workspace keys** (`kp_live_…`) — Admin → API keys. For shared agents, integrations, and CI. They act for the workspace.
- **Personal keys** (`kp_user_…`) — Account → API keys. They act as *you*, in this workspace.

Either kind is shown once at creation and stored hashed; copy it then or make a new one. Every key is bound to one workspace — access to another workspace means another key. What to pick when connecting an agent: [Connect an agent](../agents/connect-an-agent.md).

## Webhooks

**Admin → Webhooks** registers endpoints that receive record events, pauses them, rotates their signing secrets, and shows the delivery log. The integrator's half — verifying signatures, retry semantics — lives in [API and webhooks](../agents/api-and-webhooks.md).

## Your account

- **Profile** — name and email.
- **Security** — change your password, and see and sign out sessions. Sessions currently show the browser's raw identification string rather than a friendly "Chrome on macOS", and location is not recorded.
- **Preferences** — your timezone and theme, which follow your account across devices. The email-notification choices (weekly digest, mentions, product updates) are stored but **nothing sends these emails yet** — the page says so on screen.
- **API keys** — your personal keys, as above.

## Deleting a workspace

Owner only. You type the workspace slug as confirmation, and the check happens in the service — an accidental click cannot get through. Deletion removes everything the workspace owns: records, handbook, forms, keys, webhooks, the lot. Accounts are global and survive it.

The owner also cannot *leave* a workspace: hand ownership to someone else first. An owner who is the only member has no exit except deletion.
