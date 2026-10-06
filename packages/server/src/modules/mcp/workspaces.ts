import type { OAuthActor, OAuthConnectionActor } from '../../lib/actor.ts'
import { bindOAuthWorkspace } from '../../lib/actor.ts'
import { AppError } from '../../lib/errors.ts'
import type { PublishedTool } from './protocol.ts'

/**
 * How one OAuth connection reaches more than one workspace.
 *
 * A token for one workspace needs none of this: the token alone decides the
 * workspace, as an API key does. A connection the user approved for several
 * has no workspace of its own, so each tool call must name one. Nothing here
 * keeps a "current workspace": the endpoint holds no session, and a default the
 * agent cannot see is how a record goes to the wrong workspace.
 */

/** The argument every tool gains for such a connection. No tool has one of its own. */
export const WORKSPACE_ARGUMENT = 'workspace_id'

/** The one tool that takes no workspace: it is how the agent learns the ids. */
export const WORKSPACES_LIST_TOOL = 'workspaces_list'

const WORKSPACE_ARGUMENT_SCHEMA = {
  type: 'string',
  description: `The workspace to act in. This connection covers more than one. Call ${WORKSPACES_LIST_TOOL} for the ids.`,
} as const

const WORKSPACES_LIST: PublishedTool = {
  name: WORKSPACES_LIST_TOOL,
  description:
    `List the workspaces this connection covers: id, name, and your role in each. Every other tool needs one of these ids as ${WORKSPACE_ARGUMENT}.`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

/** Appended to the instructions an agent reads on `initialize` and `server/discover`. */
const CONNECTION_INSTRUCTIONS = [
  '',
  'This connection covers more than one workspace, so the first paragraph above does',
  'not apply to it:',
  `- Call ${WORKSPACES_LIST_TOOL} first. Every other tool needs a ${WORKSPACE_ARGUMENT} from it.`,
  '- Each workspace is a separate company brain. Its decisions, handbook and records',
  '  apply to that workspace only.',
  '- Do not copy or move data from one workspace to another unless the user asks for it.',
].join('\n')

export function connectionInstructions(instructions: string): string {
  return `${instructions}\n${CONNECTION_INSTRUCTIONS}`
}

function withWorkspaceArgument(tool: PublishedTool): PublishedTool {
  const properties =
    typeof tool.inputSchema.properties === 'object' && tool.inputSchema.properties !== null
      ? (tool.inputSchema.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as unknown[]) : []

  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { [WORKSPACE_ARGUMENT]: WORKSPACE_ARGUMENT_SCHEMA, ...properties },
      required: [WORKSPACE_ARGUMENT, ...required],
    },
  }
}

/**
 * The tool listing for a connection that covers more than one workspace.
 *
 * @throws When a tool already has a `workspace_id` argument or is named
 *   `workspaces_list`. Called at mount, so a module that adds either fails boot
 *   rather than having its argument silently replaced.
 */
export function publishForConnection(published: readonly PublishedTool[]): readonly PublishedTool[] {
  for (const tool of published) {
    const properties = tool.inputSchema.properties

    if (tool.name === WORKSPACES_LIST_TOOL) {
      throw new Error(`The MCP tool name "${WORKSPACES_LIST_TOOL}" is reserved`)
    }

    if (typeof properties === 'object' && properties !== null && WORKSPACE_ARGUMENT in properties) {
      throw new Error(`MCP tool "${tool.name}" takes "${WORKSPACE_ARGUMENT}", which is reserved`)
    }
  }

  return [WORKSPACES_LIST, ...published.map(withWorkspaceArgument)]
}

/** What `workspaces_list` answers. */
export function listConnectionWorkspaces(actor: OAuthConnectionActor): { readonly data: readonly unknown[] } {
  return {
    data: actor.workspaces.map((workspace) => ({
      id: workspace.workspaceId,
      name: workspace.workspaceName,
      role: workspace.role,
    })),
  }
}

/** A tool call's arguments with the workspace taken out, and the actor to run it as. */
export interface BoundCall {
  readonly actor: OAuthActor
  readonly arguments: unknown
}

function splitWorkspace(rawArguments: unknown): { readonly workspaceId: unknown; readonly rest: unknown } {
  if (typeof rawArguments !== 'object' || rawArguments === null || Array.isArray(rawArguments)) {
    return { workspaceId: undefined, rest: rawArguments }
  }

  const { [WORKSPACE_ARGUMENT]: workspaceId, ...rest } = rawArguments as Record<string, unknown>

  return { workspaceId, rest }
}

/** One answer for a workspace that does not exist and one the connection does not cover. */
function unknownWorkspace(): AppError {
  return AppError.notFound(
    `This connection does not cover that workspace. Call ${WORKSPACES_LIST_TOOL} for the ids it covers`,
  )
}

/**
 * Binds a call on a multi-workspace connection to the workspace it names.
 *
 * @throws AppError 422 when the call names no workspace; 404 when the
 *   connection does not cover the one it names.
 */
export function bindConnectionCall(actor: OAuthConnectionActor, rawArguments: unknown): BoundCall {
  const { workspaceId, rest } = splitWorkspace(rawArguments)

  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    const message = `${WORKSPACE_ARGUMENT} is required: this connection covers more than one workspace. Call ${WORKSPACES_LIST_TOOL} for the ids`

    throw AppError.validationFailed(message, [{ field: WORKSPACE_ARGUMENT, message }])
  }

  const bound = bindOAuthWorkspace(actor, workspaceId)

  if (bound === undefined) {
    throw unknownWorkspace()
  }

  return { actor: bound, arguments: rest }
}

/**
 * A call on a connection that covers one workspace.
 *
 * Such a connection has no `workspace_id` argument. A client can still send
 * one: it listed the tools when the connection covered two workspaces, and the
 * user has since disconnected one. The id is accepted when it is the workspace
 * the connection has, so that client keeps working, and refused otherwise, so
 * a call meant for the other workspace never lands in this one.
 *
 * @throws AppError 404 when the call names another workspace.
 */
export function stripBoundWorkspace(actor: OAuthActor, rawArguments: unknown): unknown {
  const { workspaceId, rest } = splitWorkspace(rawArguments)

  if (workspaceId === undefined) {
    return rawArguments
  }

  if (workspaceId !== actor.workspaceId) {
    throw unknownWorkspace()
  }

  return rest
}
