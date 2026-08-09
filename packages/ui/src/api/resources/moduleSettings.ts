import { moduleSettingSchema, updateModuleSettingBody } from '@kelpie/schemas'
import type { ModuleSetting } from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'
import { useSession } from './session.ts'

/**
 * `/v1/workspaces/:id/modules`: which optional modules this workspace has on.
 *
 * Not built on `createResourceHooks`: there is no create or delete, the path
 * carries the workspace id, and the endpoint answers every toggleable module in
 * one page rather than a cursor list.
 */

const MODULE_SETTINGS_KEY = 'module-settings'

export interface ModuleSettingsState {
  readonly settings: readonly ModuleSetting[]
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useModuleSettings(): ModuleSettingsState {
  const client = useApiClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? undefined
  const result = useQuery({
    queryKey: [MODULE_SETTINGS_KEY, workspaceId],
    queryFn: () => client.list(`/workspaces/${workspaceId ?? ''}/modules`, moduleSettingSchema.parse),
    enabled: workspaceId !== undefined,
  })

  return {
    settings: result.data?.items ?? [],
    isLoading: result.isPending && workspaceId !== undefined,
    error: toError(result.error),
  }
}

export interface SetModuleEnabledArguments {
  readonly moduleId: string
  readonly enabled: boolean
}

export function useSetModuleEnabled(): MutationResult<SetModuleEnabledArguments, ModuleSetting> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const { session } = useSession()
  const workspaceId = session?.workspaceId ?? ''
  const mutation = useMutation({
    mutationFn: ({ moduleId, enabled }: SetModuleEnabledArguments) =>
      client.patch(
        `/workspaces/${workspaceId}/modules/${moduleId}`,
        updateModuleSettingBody({ enabled }),
        moduleSettingSchema.parse,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [MODULE_SETTINGS_KEY, workspaceId] })
    },
  })

  return asMutationResult(mutation)
}
