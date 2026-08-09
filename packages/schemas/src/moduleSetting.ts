import { z } from 'zod'

/**
 * Wire shapes for `/v1/workspaces/:id/modules`.
 *
 * No `id` or timestamps: a setting is identified by `module_id`, and a reader
 * only ever needs the current value, not its history.
 */

export interface ModuleSetting {
  readonly moduleId: string
  readonly enabled: boolean
  /** True when a deploy-time config file holds this value, not the workspace's own choice. */
  readonly locked: boolean
}

export const moduleSettingSchema: z.ZodType<ModuleSetting, unknown> = z
  .object({
    module_id: z.string(),
    enabled: z.boolean(),
    locked: z.boolean(),
  })
  .transform(
    (wire): ModuleSetting => ({
      moduleId: wire.module_id,
      enabled: wire.enabled,
      locked: wire.locked,
    }),
  )

export interface UpdateModuleSettingInput {
  readonly enabled: boolean
}

export function updateModuleSettingBody(input: UpdateModuleSettingInput): Record<string, unknown> {
  return { enabled: input.enabled }
}
