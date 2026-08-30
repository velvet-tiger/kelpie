import type { McpServerInfo } from './protocol.ts'

/**
 * The MCP endpoint's identity and address.
 *
 * Not a `KelpieModule`: its tools come from every module that registered one, so
 * there is nothing to mount until the whole registration pass has finished. The
 * app mounts it after the `/v1` routers, which is `architecture.md` boot step 6.
 */

/** Where the transport mounts. `brief.md` and the client config snippets say `/mcp`. */
export const MCP_ROUTE_PREFIX = '/mcp'

/**
 * `version` is the `@kelpie/server` package version. Both sit at `0.0.0` until
 * there is a release process to move them; a client shows this string when it
 * lists the connection, so it is worth keeping honest rather than inventing one.
 */
export const MCP_SERVER_INFO: McpServerInfo = {
  name: 'kelpie',
  title: 'Kelpie',
  version: '0.0.0',
}

/**
 * Sent on `initialize`. An agent reads this before it reads a tool description,
 * so it says what the data is for and which habits `brief.md` asks of it, not
 * what the tools are named.
 */
export const MCP_INSTRUCTIONS = [
  'Kelpie is a CRM and company brain for one workspace. Your API key fixes which',
  'workspace you can see; there is no way to reach another.',
  '',
  'The tools mirror the REST API one for one. Names are the resource then the verb:',
  'people_list, people_get, people_create, people_update, people_delete. Arguments and',
  'results are snake_case JSON. Lists are cursor paged: pass the next_cursor you were',
  'given back as cursor, and filter free text with q.',
  '',
  'Working habits this workspace expects:',
  '- Read decisions_list before proposing anything. A decision is a commitment already',
  '  made, and contradicting one is worse than saying nothing.',
  '- Prefer pinned notes (notes_list with pinned true) over unpinned ones. They are',
  '  pinned because somebody decided they carry the signal.',
  '- The handbook holds voice, ICP, and how this company sells. Read handbook_pages_list',
  '  before writing anything a customer will see.',
  '- A job title belongs to a position, not a person. A person may hold several.',
  '- A person has one name, which is what to call them and what every list shows.',
  '  first_name, last_name, salutation and suffix are optional detail beside it. Send',
  '  the parts when you know them; people_create composes a name from first_name and',
  '  last_name when you send no name. Never split a name into parts yourself, and note',
  '  that changing a part does not rename the person — send name to do that.',
  '- Next steps are plan_items with a date and an owner, not prose in a summary field.',
].join('\n')

export type { McpServerInfo } from './protocol.ts'
export { createMcpEndpoint } from './router.ts'
export type { McpEndpoint, McpRouterDependencies } from './router.ts'
