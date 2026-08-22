# @kelpie/module-smtp-email

The first-party [Kelpie](https://github.com/velvet-tiger/kelpie) module that sends transactional mail (invites, password resets, email verifications) over SMTP.

Kelpie's core owns the `EmailSender` port and resolves the deployment's sender by name at boot. This module registers a sender under the name `smtp`. Set `EMAIL_PROVIDER=smtp` (or `email.provider: 'smtp'` in `kelpie.config.ts`) to use it.

## Install

```bash
npm install @kelpie/module-smtp-email
```

## Use

Add the module to your assembly and pick it in `email.provider`:

```ts
import { defineKelpieConfig, coreModules, fromEnv } from '@kelpie/server'
import { smtpEmail } from '@kelpie/module-smtp-email'
import { z } from 'zod'

export default defineKelpieConfig({
  // ...
  email: {
    provider: fromEnv('EMAIL_PROVIDER', z.string().min(1)),
    from: fromEnv('EMAIL_FROM', z.string().min(1)),
  },
  modules: [...coreModules, smtpEmail()],
})
```

Then set `EMAIL_PROVIDER=smtp` in the environment. The module can stay in the `modules:` list even when a different provider is picked — it only becomes the sender when `email.provider` names it.

Set these in the environment (or lock them in `env:` inside `kelpie.config.ts`):

| Variable | Meaning |
| --- | --- |
| `EMAIL_FROM` | The `From:` address on every message |
| `SMTP_HOST` | The mail server to connect to |
| `SMTP_PORT` | The mail server's port |
| `SMTP_SECURE` | `true` or `false`. `true` connects over TLS from the start (typically port 465). `false` upgrades with STARTTLS (typically 587 or 25) |
| `SMTP_USER` | The SMTP username |
| `SMTP_PASSWORD` | The SMTP password |

Any missing or malformed variable fails boot with a specific error, so the module never runs half-configured.

Set `EMAIL_PROVIDER=log` to send nothing (mail writes to the log instead) — no code change needed.

## License

AGPL-3.0-only. See `LICENSE`.
