# API and webhooks

Call Kelpie's REST API directly and receive signed webhook events. This page is the integrator's orientation; the endpoint-by-endpoint detail is the [API reference](../api-reference.md).

## Authentication

```
Authorization: Bearer kp_live_…    # workspace key
Authorization: Bearer kp_user_…    # personal key, acts as its user
```

Keys come from Admin → API keys (workspace) or Account → API keys (personal), are shown once, and are each bound to one workspace. Cookie sessions exist for browsers; integrations use keys.

## Conventions in sixty seconds

- Everything lives under `/v1`; changes within it are additive only.
- Bodies are `snake_case` JSON. Timestamps are ISO 8601 UTC; money is integer cents plus a currency code.
- Ids look like `per_01J8ZQ3R9V6X` — a type prefix plus a sortable ULID.
- Lists return `{ "data": […], "next_cursor": "…" }`. Cursors are opaque and bound to the sort that issued them; `?limit=` caps at 200.
- Filters are explicit query parameters. An id filter repeats to name a set: `?person_id=per_1&person_id=per_2` (up to 200).
- Errors share one shape: `{ "error": { "code", "message", "details?" } }` with conventional statuses; `422` carries field-level details.
- `POST` endpoints accept an `Idempotency-Key` header: replaying the key within 24 hours returns the original response instead of re-executing.
- The workspace is implicit in your key. There is no workspace parameter anywhere.

## Rate limits

Key traffic on `/v1` is metered per key — 600 requests per 60 seconds by default. Over budget answers `429` with `Retry-After`; honour it and back off.

## The UI has no private API

Anything the app can do, you can do — the pages consume this same public API. If you can click it, you can script it.

## Custom fields

Every record on the six taggable types (Person, Company, Deal, Opportunity, Partnership, Raise) carries a `custom_fields` object over the wire. The keys are workspace-defined: list `GET /v1/custom_fields?object_type=deal` (or call `custom_fields_list` over MCP) before writing values so you know which keys the workspace accepts and what type each one expects. A record `PATCH` on `custom_fields` is a partial merge — send only the keys you're changing, use `null` to clear a key, and expect `422` on an unknown key. `custom_fields.field.*` events fire on definition CRUD but are not bridged to webhooks (they're workspace configuration, not record events). Full details in `custom-fields.md` beside this repository.

## Webhooks

Webhooks push record events to your endpoint as they happen. Manage them at Admin → Webhooks (admin only, reads included, because endpoint URLs often carry credentials).

Four events are deliverable: `record.created`, `record.updated`, `record.deleted`, and `form.submitted`. Registering for anything else is refused rather than accepted and never sent.

Registering returns the signing secret **once**. A delivery is a POST:

```json
{
  "id": "whd_01J8ZQ3R9V6X",
  "event": "record.created",
  "created_at": "2026-08-24T01:00:00.000Z",
  "workspace_id": "ws_01J8ZQ3R9V6X",
  "data": { "object_type": "person", "record_id": "per_01J8ZQ3R9V6X" }
}
```

with three headers:

| Header | Use |
| --- | --- |
| `Kelpie-Signature` | `sha256=<hex>` — an HMAC-SHA256 of the exact request body under your secret. |
| `Kelpie-Event` | The event name, for routing before you parse. |
| `Kelpie-Delivery` | The delivery id. Retries reuse it — **this is your dedupe key**. |

## Verifying a signature

Split the header on commas and accept if **any** value matches your computed signature:

```
expected = "sha256=" + hex(hmac_sha256(secret, raw_body))
accept   = any(value == expected for value in header.split(","))
```

Never compare the whole header to one expected string. It carries one value almost always — and two during a secret rotation's overlap window, when deliveries are signed under both the new and the old secret for 24 hours. A receiver comparing the whole header works right up until the first rotation and then fails. Compute the HMAC over the raw received bytes; re-serialising the parsed JSON breaks it.

## Rotating a secret

Rotate from the Webhooks admin page (or the API). You choose: an immediate rotation retires the old secret at once — right when a secret has leaked — or an overlapping one keeps signing under both for 24 hours so an endpoint that has not been redeployed yet still verifies. The registration keeps its id, subscriptions, and delivery log; only the secret changes.

## Delivery behaviour

- **At-least-once.** Design your receiver to be idempotent, keyed on `Kelpie-Delivery`.
- A non-2xx response is a failure — and so is a redirect, which is never followed. Register the final URL.
- Failures retry three times over about twenty seconds. When attempts run out the registration reads `failing`, and it returns to `active` on its own when a delivery lands. `paused` is your own switch and stops delivery entirely.
- The delivery log keeps 30 days by default (operator-configurable) and is visible on the admin page.

## Limits to design around

Deliveries and their retries live in the server process — there is no durable queue. A crash mid-retry loses that delivery. Treat webhooks as a fast signal, not a ledger: anything you cannot afford to miss, reconcile by polling the API.
