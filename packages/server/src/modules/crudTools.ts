import { z } from 'zod'
import type { ZodType } from 'zod'

import type { Actor } from '../lib/actor.ts'
import { MAX_FILTER_IDS } from '../lib/http.ts'
import { MAX_PAGE_SIZE } from '../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../lib/pagination.ts'
import type { McpToolRegistry } from '../runtime/module.ts'

/**
 * The five tools a CRM resource gets, built from the pieces its routes already
 * carry: the same Zod bodies, the same wire mappers, the same renderer.
 *
 * Written once because every resource's service is the same five methods. A tool
 * that reached for a repository, or re-derived a wire shape of its own, would be
 * the drift `api.md` forbids: MCP mirrors the endpoints one for one, same auth,
 * same shapes, same errors.
 */

/** What every CRM service offers. Filters differ per resource; the verbs do not. */
export interface CrudService<View, CreateInput, UpdateInput, Filters> {
  list(actor: Actor, filters: Filters, query: ListQueryParameters): Promise<Page<View>>
  get(actor: Actor, id: string): Promise<View>
  create(actor: Actor, input: CreateInput): Promise<View>
  update(actor: Actor, id: string, changes: UpdateInput): Promise<View>
  remove(actor: Actor, id: string): Promise<void>
}

/** An id argument. Present and non-empty; whether it exists is the service's answer. */
export const idArg = z.string().min(1)

/**
 * A filter naming one id or a set of them, mirroring the repeated query parameter
 * `?person_id=a&person_id=b` from `api.md`.
 *
 * A bare string is accepted because asking about one record is the ordinary case
 * and an agent should not have to wrap it in an array to do so. The ceiling is the
 * same `MAX_FILTER_IDS` the REST surface enforces, so the two refuse the same
 * request.
 */
export const idSetArg = z.union([idArg, z.array(idArg).min(1).max(MAX_FILTER_IDS)])

/** The same shape for a filter over a closed set of values: `?status=open&status=closed`. */
export function enumSetArg<Value extends string>(
  values: readonly [Value, ...Value[]],
): ZodType<Value | Value[]> {
  return z.union([z.enum(values), z.array(z.enum(values)).min(1).max(MAX_FILTER_IDS)])
}

/** Normalises either form of the filter above to the array a service filter takes. */
export function toSet<Value extends string>(
  value: Value | readonly Value[] | undefined,
): readonly Value[] | undefined {
  if (value === undefined) {
    return undefined
  }

  return typeof value === 'string' ? [value] : value
}

/**
 * Paging arguments, spread into every list tool's schema.
 *
 * `limit` is a number here and a string on the query line. The wire had no choice;
 * a JSON Schema does, and a tool that declares the type it means is one an agent
 * gets right the first time.
 */
export const listWindowShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe(`How many records to return. 1 to ${String(MAX_PAGE_SIZE)}, default 50.`),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('The next_cursor from the previous page. Opaque; do not build one.'),
  sort: z
    .string()
    .min(1)
    .optional()
    .describe('A documented sort field, or the same name prefixed with - for descending.'),
}

export interface ListWindowArgs {
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
  readonly sort?: string | undefined
}

/** The free-text filter every list carries, matching `?q=`. */
export const termArg = z
  .string()
  .min(1)
  .optional()
  .describe('Free text. Matches the same fields the equivalent REST list matches.')

/** Turns the tool's typed window into the strings `readListWindow` parses. */
export function toListQuery(args: ListWindowArgs): ListQueryParameters {
  return {
    limit: args.limit === undefined ? undefined : String(args.limit),
    sort: args.sort,
    cursor: args.cursor,
  }
}

/** The `{ data, next_cursor }` envelope, identical to the REST one. */
export function pageResult<View>(
  page: Page<View>,
  render: (view: View) => Record<string, unknown>,
): Record<string, unknown> {
  return { data: page.items.map(render), next_cursor: page.nextCursor }
}

export interface CrudToolSpec<
  View,
  CreateInput,
  UpdateInput,
  Filters,
  ListArgs extends ListWindowArgs,
  CreateArgs,
  UpdateArgs extends { readonly id: string },
> {
  /** The REST path segment, which is also the tool-name prefix: `people`. */
  readonly resource: string
  /** Singular, for descriptions: `person`. */
  readonly subject: string
  /** One line an agent reads to know what this object is for. */
  readonly about: string
  readonly service: CrudService<View, CreateInput, UpdateInput, Filters>
  readonly render: (view: View) => Record<string, unknown>
  /** Filters plus `listWindowShape`. Flat, so the published JSON Schema is one object. */
  readonly listArgs: ZodType<ListArgs>
  readonly toFilters: (args: ListArgs) => Filters
  readonly createArgs: ZodType<CreateArgs>
  readonly toCreateInput: (args: CreateArgs) => CreateInput
  /** The update body plus a required `id`. */
  readonly updateArgs: ZodType<UpdateArgs>
  readonly toUpdateInput: (args: UpdateArgs) => UpdateInput
  /**
   * Replaces the by-id delete tool, for a resource whose REST delete takes more
   * than an id. Pipeline stages are the only one: removing a stage may name where
   * the records standing in it go.
   */
  readonly registerDelete?: (mcp: McpToolRegistry) => void
}

/** What a delete tool answers with, since the REST delete answers 204 and no body. */
export function deleteResult(id: string): Record<string, unknown> {
  return { id, deleted: true }
}

/**
 * Registers `<resource>_list`, `_get`, `_create`, `_update` and `_delete`.
 *
 * Resource first so a client's tool list groups by object rather than by verb,
 * which is what makes a list of roughly a hundred tools navigable.
 */
export function registerCrudTools<
  View,
  CreateInput,
  UpdateInput,
  Filters,
  ListArgs extends ListWindowArgs,
  CreateArgs,
  UpdateArgs extends { readonly id: string },
>(
  mcp: McpToolRegistry,
  spec: CrudToolSpec<View, CreateInput, UpdateInput, Filters, ListArgs, CreateArgs, UpdateArgs>,
): void {
  const { resource, subject, about, service, render } = spec

  mcp.tool({
    name: `${resource}_list`,
    description: `List ${subject} records. ${about} Cursor paged. Mirrors GET /v1/${resource}.`,
    inputSchema: spec.listArgs,
    invoke: async (args, actor) =>
      pageResult(await service.list(actor, spec.toFilters(args), toListQuery(args)), render),
  })

  mcp.tool({
    name: `${resource}_get`,
    description: `Fetch one ${subject} by id. ${about} Mirrors GET /v1/${resource}/{id}.`,
    inputSchema: z.strictObject({ id: idArg }),
    invoke: async ({ id }, actor) => render(await service.get(actor, id)),
  })

  mcp.tool({
    name: `${resource}_create`,
    description: `Create a ${subject}. ${about} Mirrors POST /v1/${resource}.`,
    inputSchema: spec.createArgs,
    invoke: async (args, actor) => render(await service.create(actor, spec.toCreateInput(args))),
  })

  mcp.tool({
    name: `${resource}_update`,
    description:
      `Update a ${subject}. Only the fields you send change; null clears a nullable one. ` +
      `Mirrors PATCH /v1/${resource}/{id}.`,
    inputSchema: spec.updateArgs,
    invoke: async (args, actor) =>
      render(await service.update(actor, args.id, spec.toUpdateInput(args))),
  })

  if (spec.registerDelete !== undefined) {
    spec.registerDelete(mcp)

    return
  }

  mcp.tool({
    name: `${resource}_delete`,
    description:
      `Delete a ${subject}. Dependent records go with it; a record something else ` +
      `independently references refuses with a conflict. Mirrors DELETE /v1/${resource}/{id}.`,
    inputSchema: z.strictObject({ id: idArg }),
    invoke: async ({ id }, actor) => {
      await service.remove(actor, id)

      return deleteResult(id)
    },
  })
}
