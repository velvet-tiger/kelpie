import type { ModuleContext } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { createCustomFieldValues } from '../custom-fields/index.ts'
import { createConversionsService } from './service.ts'
import type { ConversionsService } from './service.ts'

/** Build the shared conversion service from a module registration context. */
export function createConversionsFromContext(context: ModuleContext): ConversionsService {
  return createConversionsService({
    db: context.db,
    transaction: context.transaction,
    createId: context.createId,
    now: context.now,
    recordActivity: createActivityRecorder({
      createId: context.createId,
      now: context.now,
    }),
    customFields: createCustomFieldValues({ db: context.db }),
  })
}
