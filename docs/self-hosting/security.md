# Security

Kelpie's security model on one page, for the operator asking "what am I running?" and the reviewer asking "is it safe?". Everything here describes shipped behaviour.

## Workspaces are the isolation boundary

Every workspace-owned row carries a workspace id, every query is scoped to it server-side, and the workspace comes from the credential — never from a request header or body. A record in another workspace answers `404`, indistinguishable from not existing.

## Passwords, tokens, and keys

| Value | Storage |
| --- | --- |
| Account passwords | argon2id hashes. Minimum length 12. |
| Session, invitation, password-reset, and email-verification tokens | SHA-256 hashes. Only ever compared, never read back. |
| API key secrets | SHA-256 hashes; the key is shown once at creation, and the UI keeps only a display prefix and the last four characters. Optional scopes limit what each key can reach; empty scopes mean full access. A scoped key cannot create a key that reaches more than it does. A Decision from a key is a proposal until a member confirms it, unless the key has `decisions:commit`, which no preset includes. Prefer preset bundles (`read:objects`, `write:objects`, `admin:objects`, `admin`) for integrations rather than minting unrestricted keys. |
| Webhook signing secrets and agent auth headers | Encrypted (AES-256-GCM) under `SECRET_ENCRYPTION_KEY`, because the service must read them back to sign deliveries and authorise dispatches. |

The rule behind the table: a value the service only checks is hashed; a value it must use again is encrypted. Rotating the encryption key is a supported, four-step procedure — see [Production](production.md#rotating-the-encryption-key).

Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` everywhere except development, so a deployment must set `NODE_ENV=production` ([Production](production.md#build-and-serve)). Confirming a password reset ends every session on the account.

The cookie is not the only defence against a forged request. A request under `/v1` that changes something and carries no API key must come from a page of your deployment: the browser states the page's origin in the `Origin` header, and Kelpie compares it with the host the request arrived on. Another origin gets `403`. The body must also be `application/json`, which a page on another origin cannot send without permission; another content type gets `415`. A sign-in request is checked the same way, so another site cannot sign a reader in to an account of its choice. For this to work behind a reverse proxy, the proxy must keep the `Host` header ([Production](production.md#a-reverse-proxy-with-tls)).

## Email verification and link building

A password reset request answers `202` for every address and does the same work for each: it adds one background job and does not read the accounts table. The job finds the account, or finds none, after the caller has its answer. The response and its timing thus do not show which addresses have accounts, and a mail server that is down does not change them.

Emailed links hold a single-use token, and the database stores only its hash. The job that sends the email makes the token when it runs, so no job payload holds one.

An account must verify its email address before it can create a workspace; accepting an invitation verifies as a side effect, since the invite link already proves control of the address. Every emailed link is built server-side from your `APP_BASE_URL` plus a fixed path — a caller can never supply the link target, which closes the classic account-takeover path.

## Request size

Every request body has a limit. A body over it gets `413` with the code `payload_too_large` before a handler runs. The limit is 1 MB; 256 KB under `/v1/public`; 11 MB for the import upload and the import commit; 15 MB for `/mcp`, where the import tools take the file as text. If a reverse proxy sits in front of Kelpie, set its body limit to 15 MB or more, or the larger imports stop at the proxy.

## Rate limits

Four fixed-window budgets, all configurable ([Configuration](configuration.md#rate-limits)): public forms and unauthenticated auth per client IP, login additionally per account, and API-key traffic per key. The per-account login budget is the one an IP-rotating attacker cannot reset. Set `TRUSTED_PROXY_HOP_COUNT` behind a proxy so the limiter meters real clients.

## The public surface

`/v1/public` is the only surface that answers without credentials: form submit and embed by public key, plus `GET /v1/public/config`. It is mounted outside the credentialled routes and answers any origin **without credentials**, so a browser never spends a signed-in user's cookie there. A public form submission returns no record ids — an id would tell an anonymous caller whether the person or company it named already existed.

## Response headers

Every response carries `Strict-Transport-Security`, `X-Content-Type-Options`, and `Referrer-Policy`, and `X-Frame-Options: DENY` on everything except the hosted form-embed page, which is the one response meant to be framed and ships its own strict `Content-Security-Policy` instead.

## The MCP endpoint

`POST /mcp` accepts bearer API keys only — deliberately not the session cookie the rest of the API takes. A request carrying an `Origin` other than the deployment's own answers `403`, no CORS headers are ever sent, and `GET`/`DELETE` answer `405`. A hostile web page therefore has neither a way in nor an ambient credential to spend.

## Outbound requests

Webhook deliveries and agent-task dispatches are the two places Kelpie POSTs to URLs your users typed. Redirects are never followed — a moved endpoint should be seen and fixed, not silently posted to wherever the old address now points. With `BLOCK_PRIVATE_EGRESS=true`, URLs resolving to private or reserved addresses are refused, and the connection goes only to an address that passed that check, so a host cannot give a public address for the check and a private one for the connection. It defaults off because self-hosted installs legitimately post to internal automation. Hosted, multi-tenant deployments should turn it on and add network-level egress policy behind it.

## Roles and gates

Three roles: owner, admin, member. Administration, API keys, imports and exports, the AI run log, and the sample-data installer are admin work. Webhooks require admin **for reads too**, because a delivery URL routinely carries a credential in its path. Deleting a workspace is the owner's alone and takes the workspace name typed as confirmation, checked in the request itself. There is no read-only role today; every CRM record is open to any member.

Every `/v1` and `/mcp` request also passes a `workspace.access` entitlement gate. Self-hosted it is inert — entitlements default to granted — and it exists so a hosting operator can suspend a workspace in one place.

## Reporting a vulnerability

Report privately rather than in a public issue. Use GitHub's private vulnerability reporting on the repository if it is enabled; otherwise contact the maintainer directly.

<!-- TODO(maintainer): confirm the preferred disclosure channel and replace this placeholder. -->
