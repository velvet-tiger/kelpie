# Security

Kelpie's security model on one page, for the operator asking "what am I running?" and the reviewer asking "is it safe?". Everything here describes shipped behaviour.

## Workspaces are the isolation boundary

Every workspace-owned row carries a workspace id, every query is scoped to it server-side, and the workspace comes from the credential — never from a request header or body. A record in another workspace answers `404`, indistinguishable from not existing.

## Passwords, tokens, and keys

| Value | Storage |
| --- | --- |
| Account passwords | argon2id hashes. Minimum length 12. |
| Session, invitation, password-reset, and email-verification tokens | SHA-256 hashes. Only ever compared, never read back. |
| API key secrets | SHA-256 hashes; the key is shown once at creation, and the UI keeps only a display prefix and the last four characters. Scopes limit what each key can reach. A route with no scope rule is refused to a scoped key, so a new route is closed to scoped keys until it has a rule. A new key with no scopes named gets `read:objects` and `write:objects`; full access is asked for by name, and is stored as an empty scope list. A scoped key cannot create a key that reaches more than it does. A Decision from a key is a proposal until a member confirms it, unless the key has `decisions:commit`, which no preset includes. Deleting a record needs a delete scope (`delete:objects`, or one resource such as `people:delete`), which write does not include. Writing the handbook needs `handbook:write`, which `write:objects` does not include. Prefer preset bundles (`read:objects`, `write:objects`, `admin:objects`, `admin`) for integrations rather than minting unrestricted keys. |
| Webhook signing secrets and agent auth headers | Encrypted (AES-256-GCM) under `SECRET_ENCRYPTION_KEY`, because the service must read them back to sign deliveries and authorise dispatches. |

The rule behind the table: a value the service only checks is hashed; a value it must use again is encrypted. Rotating the encryption key is a supported, four-step procedure — see [Production](production.md#rotating-the-encryption-key).

Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` everywhere except development, so a deployment must set `NODE_ENV=production` ([Production](production.md#build-and-serve)). Confirming a password reset ends every session on the account, every other open reset link, every personal API key of the account and every connected app. Workspace API keys stay.

The cookie is not the only defence against a forged request. A request under `/v1` that changes something and carries no API key must come from a page of your deployment: the browser states the page's origin in the `Origin` header, and Kelpie compares it with the host the request arrived on. Another origin gets `403`. The body must also be `application/json`, which a page on another origin cannot send without permission; another content type gets `415`. A sign-in request is checked the same way, so another site cannot sign a reader in to an account of its choice. For this to work behind a reverse proxy, the proxy must keep the `Host` header ([Production](production.md#a-reverse-proxy-with-tls)).

## Email verification and link building

A password reset request answers `202` for every address and does the same work for each: it adds one background job and does not read the accounts table. The job finds the account, or finds none, after the caller has its answer. The response and its timing thus do not show which addresses have accounts, and a mail server that is down does not change them.

Emailed links hold a single-use token, and the database stores only its hash. The job that sends the email makes the token when it runs, so no job payload holds one.

The `log` email provider writes each message to the log, and a message body holds its link. In production it writes the length of the body and not the body, so a person who can read the log cannot sign in as another person. `EMAIL_LOG_BODY=true` puts the body back. The service logs a warning at boot when a production deployment uses the `log` provider.

Mail to an SMTP server on another machine is always encrypted. With `SMTP_SECURE=false` the connection must upgrade with STARTTLS before the password or a message goes over it, and a server that does not offer the upgrade fails the send. The server certificate is always checked. `SMTP_REQUIRE_TLS=false` turns the rule off for a relay on a private network that you trust. Both variables: [Configuration](configuration.md#email).

An account must verify its email address before it can create a workspace; accepting an invitation verifies as a side effect, since the invite link already proves control of the address. Every emailed link is built server-side from your `APP_BASE_URL` plus a fixed path — a caller can never supply the link target, which closes the classic account-takeover path.

## Request size

Every request body has a limit. A body over it gets `413` with the code `payload_too_large` before a handler runs. The limit is 1 MB; 256 KB under `/v1/public`; 11 MB for the import upload and the import commit; 15 MB for `/mcp`, where the import tools take the file as text. If a reverse proxy sits in front of Kelpie, set its body limit to 15 MB or more, or the larger imports stop at the proxy.

## Rate limits

Five fixed-window budgets, all configurable ([Configuration](configuration.md#rate-limits)): public forms, unauthenticated auth and the OAuth endpoints per client IP, attempts on one account, and API-key traffic per key. The account budget covers login, password reset requests for one address, checks of the current password by a signed-in person, and requests to send the verification mail again. The per-account login budget is the one an IP-rotating attacker cannot reset. An IPv6 client is counted by its `/64` prefix. Set `TRUSTED_PROXY_HOP_COUNT` behind a proxy so the limiter meters real clients.

## The public surface

`/v1/public` is the only surface that answers without credentials: form submit and embed by public key, plus `GET /v1/public/config`. It is mounted outside the credentialled routes and answers any origin **without credentials**, so a browser never spends a signed-in user's cookie there. A public form submission returns no record ids — an id would tell an anonymous caller whether the person or company it named already existed.

## Response headers

Every response carries `Strict-Transport-Security`, `X-Content-Type-Options`, and `Referrer-Policy`, and `X-Frame-Options: DENY` on everything except the hosted form-embed page, which is the one response meant to be framed and ships its own strict `Content-Security-Policy` instead.

## The MCP endpoint

`POST /mcp` accepts bearer API keys only — deliberately not the session cookie the rest of the API takes. A request carrying an `Origin` other than the deployment's own answers `403`, no CORS headers are ever sent, and `GET`/`DELETE` answer `405`. A hostile web page therefore has neither a way in nor an ambient credential to spend.

## OAuth sign-in for MCP clients

Anybody can register an OAuth client, so these endpoints trust nothing a client says about itself.

**Redirect URIs.** A client may register three kinds, and every other scheme is refused: `https:` on any host; `http:` on `localhost`, `127.0.0.1` or `[::1]` only; and a private-use scheme of a desktop app, which is a reverse domain name with a dot in it (`com.example.app:/callback`) or one of `cursor:`, `vscode:`, `vscode-insiders:` and `windsurf:`. No fragment and no credentials in the URI. The rule applies to Dynamic Client Registration and to Client ID Metadata Documents, and again before each redirect. An earlier version refused a short list of schemes and allowed the rest, so an old row can hold a URI that is now refused. Such a client gets an error page until it registers again. This query lists them:

```sql
SELECT id, client_id, kind, client_name, redirect_uris
FROM oauth_clients
WHERE EXISTS (
  SELECT 1 FROM unnest(redirect_uris) AS uri
  WHERE uri !~* '^(https://|http://(localhost|127\.0\.0\.1|\[::1\])([:/?]|$)|(cursor|vscode|vscode-insiders|windsurf):|[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:)'
);
```

**Errors at `/oauth/authorize`.** A request that fails before the person reaches the consent page stops on an error page of your deployment. It is never sent on to the client's redirect URI, so a link to your Kelpie cannot be used to send somebody to another site. The browser goes to the redirect URI only after the person selects Allow or Deny.

**Client ID Metadata Documents.** `/oauth/authorize` fetches the HTTPS URL that a client gives as its `client_id`. The request follows no redirect, stops after 5 seconds, reads at most 64 KB, and goes through the egress guard described below when `BLOCK_PRIVATE_EGRESS=true`. Each failure gives the caller the same sentence, so the answer does not show whether a host on your network replied. The reason is in the server log, as a `warn` line with the message `oauth client metadata document refused`; the log never holds the body. A cached document that no pending request, connection or grant refers to is deleted one hour after the last authorize request that named it.

**The token endpoint.** An authorization code lasts 60 seconds and works once. The client, the `redirect_uri`, the PKCE verifier and the `resource` are checked before the code is spent, so a request that fails a check does not use the code up. A code that is presented after it was used ends the connection. A refresh token follows the same order: a request with a wrong `scope` or `resource` leaves it usable, and one that is presented after it was used ends the connection. Client credentials in an `Authorization: Basic` header that cannot be read answer `401 invalid_client`.

## Outbound requests

Webhook deliveries and agent-task dispatches are the two places Kelpie POSTs to URLs your users typed. Redirects are never followed — a moved endpoint should be seen and fixed, not silently posted to wherever the old address now points. With `BLOCK_PRIVATE_EGRESS=true`, URLs resolving to private or reserved addresses are refused, and the connection goes only to an address that passed that check, so a host cannot give a public address for the check and a private one for the connection. It defaults off because self-hosted installs legitimately post to internal automation. Hosted, multi-tenant deployments should turn it on and add network-level egress policy behind it.

When the guard refuses an agent endpoint, the run fails and its reason names the host. The reason does not name the address that the host resolved to, because every member reads a run. The address is in the server log: the `warn` line `agent dispatch failed` has it in `blockedAddress`. A refused webhook delivery is the same: the `warn` line `webhook delivery failed` has the address in `blockedAddress`, and the delivery log does not have it.

Webhooks run in the process that serves every workspace, so two limits bound what one workspace can take. A workspace registers at most 20 webhooks (`WEBHOOK_MAX_PER_WORKSPACE`). The process runs at most 20 deliveries at one time and lets 1000 wait (`WEBHOOK_MAX_CONCURRENT_DELIVERIES`, `WEBHOOK_MAX_WAITING_DELIVERIES`). A delivery over both is recorded as failed and is not sent. The limits are for the whole process, so one workspace that fills the waiting line can cause a delivery of another workspace to be refused.

## Roles and gates

Three roles: owner, admin, member. Administration, API keys, imports and exports, the AI run log, and the sample-data installer are admin work. Webhooks require admin **for reads too**, because a delivery URL routinely carries a credential in its path. Deleting a workspace is the owner's alone and takes the workspace name typed as confirmation, checked in the request itself. There is no read-only role today; every CRM record is open to any member.

Every `/v1` and `/mcp` request also passes a `workspace.access` entitlement gate. Self-hosted it is inert — entitlements default to granted — and it exists so a hosting operator can suspend a workspace in one place. The gate checks the workspace a request acts on. For `/v1/workspaces/:id/...` and for the public form routes that is the workspace in the path. For every other route it is the workspace of the session or the key.

## Reporting a vulnerability

Report privately rather than in a public issue. Use GitHub's private vulnerability reporting on the repository if it is enabled; otherwise contact the maintainer directly.

<!-- TODO(maintainer): confirm the preferred disclosure channel and replace this placeholder. -->
