import { createFormBody, formBody, formSchema, formSubmissionSchema } from '@kelpie/schemas'
import type {
  CreateFormInput,
  Form,
  FormFieldInput,
  FormInput,
  FormSubmission,
} from '@kelpie/schemas'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { isRecord } from '../json.ts'
import type { QueryParameters } from '../client.ts'
import { ApiError } from '../client.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import { createResourceHooks, usePagedList } from '../resource.ts'
import type {
  MutationResult,
  RecordListResult,
  RecordResult,
  UpdateArguments,
} from '../resource.ts'

/**
 * `/v1/forms`: embeddable inbound capture.
 *
 * A form carries its fields, so there is no separate field resource and no
 * per-field write. The whole list goes back on every save, which is what a drag
 * reorder sends as well; the server treats a list identical to the stored one as
 * no write at all, so field ids survive a save that changed nothing.
 *
 * A submit writes People, Companies, Positions and Deals, so those lists go
 * stale whenever a form changes — not because editing a form touches them, but
 * because the submissions tab links straight to records the CRM lists cache.
 */

/**
 * Everything about a form except its fields.
 *
 * The field list is excluded because the shared update hook merges the request
 * into the cached record optimistically, and a request carries *drafts*: no ids,
 * no positions, both assigned server-side. Merging those in would put a field
 * list with no ids on screen for as long as the PATCH takes, and the builder
 * addresses fields by id. `useUpdateFormFields` handles that half.
 */
export type FormSettingsInput = Omit<FormInput, 'fields'>

const forms = createResourceHooks<Form, CreateFormInput, FormSettingsInput>({
  name: 'forms',
  path: '/forms',
  decode: formSchema.parse,
  createBody: createFormBody,
  updateBody: formBody,
})

export interface FormFilters {
  /** Matches a form's name and its description. */
  readonly term?: string | undefined
  readonly status?: 'active' | 'paused' | undefined
  /** `field` ascending, `-field` descending. Only `name`, `created_at`, `updated_at` are sortable. */
  readonly sort?: string | undefined
}

function formQuery(filters: FormFilters): QueryParameters {
  return { q: filters.term, status: filters.status, sort: filters.sort }
}

export function useForms(filters: FormFilters = {}): RecordListResult<Form> {
  return forms.useList(formQuery(filters))
}

export function useForm(id: string | undefined): RecordResult<Form> {
  return forms.useRecord(id)
}

export function useCreateForm(): MutationResult<CreateFormInput, Form> {
  return forms.useCreate()
}

export function useUpdateForm(): MutationResult<UpdateArguments<FormSettingsInput>, Form> {
  return forms.useUpdate()
}

export interface UpdateFieldsArguments {
  readonly id: string
  readonly fields: readonly FormFieldInput[]
}

/**
 * Replaces a form's field list.
 *
 * Deliberately not optimistic. The response is the authority on what the list
 * became: the server assigns every field id and position from the array's order,
 * and answers with the stored list unchanged when it matches what was already
 * there. Writing the response into the cache is what turns the builder's local
 * ids into real ones.
 */
export function useUpdateFormFields(): MutationResult<UpdateFieldsArguments, Form> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ id, fields }: UpdateFieldsArguments) =>
      client.patch(`/forms/${id}`, formBody({ fields }), formSchema.parse),
    onSuccess: (form) => {
      queryClient.setQueryData(['forms', 'detail', form.id], form)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['forms', 'list'] })
    },
  })

  return {
    run: (input) => {
      mutation.mutate(input)
    },
    runAsync: (input) => mutation.mutateAsync(input),
    isPending: mutation.isPending,
    error: toError(mutation.error),
  }
}

/** Deletes the form, and by cascade its fields and its submissions. */
export function useDeleteForm(): MutationResult<string, void> {
  return forms.useRemove()
}

/**
 * One form's submissions, newest first.
 *
 * Written out rather than built from `createResourceHooks`, because the path
 * carries the form id: `GET /v1/forms/:id/submissions`. Every other resource in
 * this package is a top-level collection with a fixed path, and generalising the
 * factory for the one nested list would complicate five modules to shorten one.
 * The result shape is the same, so a page cannot tell the difference.
 */
export function useFormSubmissions(formId: string | undefined): RecordListResult<FormSubmission> {
  return usePagedList<FormSubmission>({
    queryKey: ['forms', 'submissions', formId ?? ''],
    path: `/forms/${formId ?? ''}/submissions`,
    decode: formSubmissionSchema.parse,
    query: {},
    enabled: formId !== undefined,
  })
}

/**
 * One submission on a form.
 *
 * Nested under the form rather than a top-level collection: a submission id is
 * only meaningful with its form (the field labels live there), and the path
 * mirrors the list endpoint above it.
 */
export function useFormSubmission(
  formId: string | undefined,
  submissionId: string | undefined,
): RecordResult<FormSubmission> {
  const client = useApiClient()
  const result = useQuery({
    queryKey: ['forms', 'submissions', formId ?? '', submissionId ?? ''],
    queryFn: () =>
      client.get(
        `/forms/${formId ?? ''}/submissions/${submissionId ?? ''}`,
        formSubmissionSchema.parse,
      ),
    enabled: formId !== undefined && submissionId !== undefined,
  })

  return {
    record: result.data,
    isLoading: result.isPending && formId !== undefined && submissionId !== undefined,
    isNotFound: result.error instanceof ApiError && result.error.status === 404,
    error: toError(result.error),
  }
}

/** What a customer pastes into their site, built server-side from the request origin. */
export interface EmbedSnippets {
  /** Standalone hosted page (brand chrome). */
  readonly url: string
  /** Bare document the iframe snippets load (fields only). */
  readonly embedUrl: string
  readonly iframeSnippet: string
  readonly scriptSnippet: string
}

function decodeSnippets(value: unknown): EmbedSnippets {
  if (
    !isRecord(value) ||
    typeof value.url !== 'string' ||
    typeof value.embed_url !== 'string' ||
    typeof value.iframe_snippet !== 'string' ||
    typeof value.script_snippet !== 'string'
  ) {
    throw new TypeError('Expected an embed snippet response')
  }

  return {
    url: value.url,
    embedUrl: value.embed_url,
    iframeSnippet: value.iframe_snippet,
    scriptSnippet: value.script_snippet,
  }
}

export interface EmbedSnippetsResult {
  readonly snippets: EmbedSnippets | undefined
  readonly isLoading: boolean
  readonly error: Error | null
}

/**
 * The embed URL and snippets for one form.
 *
 * Fetched rather than built here: the URL depends on the origin the API is
 * reached at, which the server knows from the request and the browser only
 * happens to share today. A cloud deployment serving the app and the API from
 * different hosts would make a locally-built URL wrong.
 */
export function useFormEmbed(formId: string | undefined): EmbedSnippetsResult {
  const client = useApiClient()
  const result = useQuery({
    queryKey: ['forms', 'embed', formId ?? ''],
    queryFn: () => client.get(`/forms/${formId ?? ''}/embed`, decodeSnippets),
    enabled: formId !== undefined,
  })

  return {
    snippets: result.data,
    isLoading: result.isPending && formId !== undefined,
    error: toError(result.error),
  }
}
