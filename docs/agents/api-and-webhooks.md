# API and webhooks

Call Kelpie's REST API directly and receive signed webhook events. This page is the integrator's orientation; the endpoint-by-endpoint detail is the [API reference](../api-reference.md).

## Authentication

```
Authorization: Bearer kp_live_…    # workspace key
Authorization: Bearer kp_user_…    # personal key, acts as its user
```

Keys come from Admin → API keys (workspace) or Account → API keys (personal), are shown once, and are each bound to one workspace. A key has scopes. `POST /v1/api-keys` with no `scopes` gives `read:objects` and `write:objects`; send `full_access: true` for a key with every scope. Cookie sessions exist for browsers; integrations use keys.

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

Every record on the six taggable types (Person, Company, Deal, Opportunity, Partnership, Raise) carries a `custom_fields` object over the wire. The keys are workspace-defined: list `GET /v1/custom_fields?object_type=deal` (or call `custom_fields_list` over MCP) before writing values so you know which keys the workspace accepts and what type each one expects. A record `PATCH` on `custom_fields` is a partial merge — send only the keys you're changing, use `null` to clear a key, and expect `422` on an unknown key. `custom_fields.field.*` events fire on definition CRUD but are not bridged to webhooks (they're workspace configuration, not record events).

## Webhooks

Webhooks push record events to your endpoint as they happen. Manage them at Admin → Webhooks (admin only, reads included, because endpoint URLs often carry credentials).

Four events are deliverable: `record.created`, `record.updated`, `record.deleted`, and `form.submitted`. Registering for anything else is refused rather than accepted and never sent.

A workspace can register 20 webhooks, unless the operator set another number. One more answers `409`. Delete a webhook to add another.

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
| `Kelpie-Event` | The event name, for routing before you parse. After you verify the signature, use `event` from the body. |
| `Kelpie-Delivery` | The delivery id, the same value as `id` in the body. Use it for logs. Do not use it as your dedupe key: the signature does not cover headers. |

The signature covers the body and nothing else. A person who has one signed delivery can send it again with other headers, and the signature still matches. Thus trust only what is in the body: the `id`, the `event` and `created_at`.

## Verifying a signature

Split the header on commas and accept if **any** value matches your computed signature:

```
expected = "sha256=" + hex(hmac_sha256(secret, raw_body))
accept   = any(constant_time_equal(value, expected) for value in header.split(","))
```

Never compare the whole header to one expected string. It carries one value almost always — and two during a secret rotation's overlap window, when deliveries are signed under both the new and the old secret for 24 hours. A receiver comparing the whole header works right up until the first rotation and then fails. Compute the HMAC over the raw received bytes; re-serialising the parsed JSON breaks it.

**Compare in constant time.** An ordinary string comparison stops at the first character that differs. The time it takes tells a sender how much of a guessed signature is correct. Use the constant-time comparison of your platform. In Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function signatureMatches(rawBody, header, secret) {
  // A request with no signature header is refused, the same as a wrong signature.
  if (typeof header !== 'string') {
    return false
  }

  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`)

  return header.split(',').some((value) => {
    const given = Buffer.from(value)

    // timingSafeEqual throws when the lengths differ. A different length is not a match.
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
```

`rawBody` is the bytes of the request as they arrived. `header` is the value of `Kelpie-Signature`; refuse a request that has none. `timingSafeEqual` throws on buffers of different lengths, so check the length first and treat a different length as no match. The length of a correct signature is not a secret.

**Verify before you parse.** Do these steps in this order:

1. Read the raw body. Do not parse it.
2. Verify the signature. If no value matches, answer `401` and stop.
3. Parse the body.
4. Refuse a body whose `created_at` is more than 5 minutes old, or more than 1 minute in the future.
5. Look up the `id` from the body. If you have processed it, answer `2xx` and do nothing more.

**Refuse an old delivery.** Step 4 stops a person who recorded a delivery from sending it again later. It does not refuse a retry. A retry has the same `id`, but Kelpie builds and signs the body again for each attempt. So a retry has a new `created_at`, the time of that attempt, and a new signature. Kelpie waits about 3 to 6, 6 to 12 and 12 to 20 seconds between attempts, and waits 10 seconds at most for the answer to each attempt. A retry can also wait in the queue behind other deliveries. Kelpie does not start a retry more than 4 minutes after the event, so every attempt arrives within about 4 minutes and 20 seconds of the first. A retry that would start later is not sent, and the delivery log shows the delivery as failed. The 5 minutes also allow for a difference between your clock and the clock of the service.

**Refuse a delivery from the future.** The clock of the service can be ahead of yours. A body with a `created_at` in the future stays inside the age limit for longer than 5 minutes of your time. Thus accept a `created_at` that is at most 1 minute ahead of your clock, and refuse one that is further ahead.

**Dedupe on the `id` in the body.** Keep each `id` until `created_at` plus 5 minutes, the age limit. Count from the `created_at` in the body, not from the time the delivery arrived. If you count from arrival and the clock of the service is ahead of yours, you forget the `id` while a copy still passes step 4. Count from the `created_at` of the first copy you processed. A retry has a later `created_at`, but no retry starts more than 4 minutes after the event, so every copy arrives while you still keep its `id`. One copy can arrive twice with no retry between them: when a Kelpie worker stops after it sent an attempt and before it recorded it, the queue runs that attempt again. That copy also starts within the 4 minutes.

## Rotating a secret

Rotate from the Webhooks admin page (or the API). You choose: an immediate rotation retires the old secret at once — right when a secret has leaked — or an overlapping one keeps signing under both for 24 hours so an endpoint that has not been redeployed yet still verifies. The registration keeps its id, subscriptions, and delivery log; only the secret changes.

## Delivery behaviour

- **At-least-once.** Design your receiver to be idempotent, keyed on the `id` in the signed body. The `Kelpie-Delivery` header has the same value, but the signature does not cover it.
- A non-2xx response is a failure — and so is a redirect, which is never followed. Register the final URL.
- Failures retry three times, with a wait that grows each time: about 3 to 6, 6 to 12 and 12 to 20 seconds. Each retry has the same `id`, and a new `created_at` and signature. No retry starts more than 4 minutes after the event. When attempts run out the registration reads `failing`, and it returns to `active` on its own when a delivery lands. `paused` is your own switch and stops delivery entirely.
- The status follows the delivery that settled last, not the newest event. A delivery that failed slowly can mark the registration `failing` after a later delivery succeeded. It stays `failing` until the next delivery lands.
- The status moves only on what your endpoint did. A delivery that Kelpie stopped is in the log as failed and does not change the status: Kelpie's own DNS server did not answer, the 4 minutes for a retry had passed, or a Kelpie worker stopped during the last attempt.
- The delivery log keeps 30 days by default (operator-configurable) and is visible on the admin page.
- A delivery is queued when the event happens. Each attempt reads the registration again, and uses the URL and the secrets that the registration has at that time. A change to the URL or a rotated secret applies to the next attempt. A delivery whose registration is paused or deleted, or no longer takes the event, is not sent again and is not logged.
- A pause is yours. A delivery that was sent before you paused can end after it, and its result is in the log. The result does not change `paused`.

## Limits to design around

Deliveries and their retries are jobs in a queue in Postgres. A restart or a deploy does not lose them. A worker that stops in the middle of an attempt can send that attempt again, so a receiver must dedupe on the `id`. Each workspace has at most 3 deliveries in progress at one time, so one workspace with a large import cannot take every slot of a Kelpie worker. A few such workspaces together can, and then other deliveries wait their turn. A large import also makes that workspace's own deliveries wait: an import of 10,000 records to 20 webhooks is 200,000 deliveries. Treat webhooks as a fast signal, not a ledger: anything you cannot afford to miss, reconcile by polling the API.

## Agent task dispatches

Separate from webhooks and from MCP connection. When someone clicks **Run** on a record page, Kelpie POSTs a resolved task to a **registered agent** — an HTTP endpoint you register on Admin → AI → Agents. Your receiver then calls Kelpie back over the API or MCP with its own key.

Kelpie does not ship a receiver and does not integrate with named AI products directly. Any server that accepts the POST works. MCP clients (Claude, Cursor, …) connect **to** Kelpie; Run dispatches **from** Kelpie **to** your endpoint.

A dispatch is a POST with `Content-Type: application/json` and an optional `Authorization` header (the stored auth header from registration). Body:

```json
{
  "run_id": "run_01J8ZQ3R9V6X",
  "workspace_id": "ws_01J8ZQ3R9V6X",
  "task_id": "company.enrich",
  "target_type": "company",
  "target_id": "com_01J8ZQ3R9V6X",
  "prompt": "…framed markdown prompt…",
  "base_prompt": "…same body, unframed…",
  "context": { "…" }
}
```

Answer **2xx within 10 seconds**. Kelpie records the dispatch, not your agent's work. **One attempt, no retries** — dedupe on `run_id`. Redirects are not followed. There is no completion callback.

Full contract, what works as a receiver, and the REST endpoints: [Agent tasks](agent-tasks.md). Wire rules: [Conventions in sixty seconds](#conventions-in-sixty-seconds).
