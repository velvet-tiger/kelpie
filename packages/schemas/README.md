# @kelpie/schemas

The wire contract for the [Kelpie](https://github.com/velvet-tiger/kelpie) API, as Zod schemas.

Kelpie is an open-source, agent-native CRM and company brain. This package is the one definition of what `/v1` sends and accepts. The service validates against it, the UI decodes with it, and an agent talking to the API can use it to parse responses instead of guessing at shapes.

It depends on Zod and nothing else. No Drizzle, no Node built-ins, nothing that would break in a browser.

## Install

```bash
npm install @kelpie/schemas
```

## Use

Every resource module exports the record the UI works with, a schema that parses the `snake_case` response into it, and a function that builds a request body.

```ts
import { personSchema } from '@kelpie/schemas'

const response = await fetch('https://example.com/v1/people/per_01J.../', {
  headers: { authorization: `Bearer ${apiKey}` },
})

const person = personSchema.parse(await response.json())
```

API keys accept optional scopes on create:

```ts
import { createApiKeyBody } from '@kelpie/schemas'

await fetch('https://example.com/v1/api-keys', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
  body: JSON.stringify(createApiKeyBody({
    name: 'Reporting bot',
    kind: 'workspace',
    scopes: ['read:objects'],
  })),
})
```

`parse` throws on a response that does not match, which is the point. A field the service renamed becomes an error where it happens rather than `undefined` three layers away.

## Licence

AGPL-3.0-only.
