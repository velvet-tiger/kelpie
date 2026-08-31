import type { IdFactory } from '../../lib/ids.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import { STARTER_FORMS } from '../forms/starters.ts'
import type { StarterConsentPurposeSlug, StarterListSlug } from '../forms/starters.ts'
import * as formsRepository from '../forms/repository.ts'
import { STARTER_LISTS } from '../lists/starters.ts'
import * as listsRepository from '../lists/repository.ts'

export interface SeedStarterFormsInput {
  readonly workspaceId: string
  readonly createId: IdFactory
  readonly generatePublicKey: () => string
  readonly consentPurposeIdsBySlug: Readonly<Partial<Record<StarterConsentPurposeSlug, string>>>
}

/**
 * Inserts the starter lists and forms for a new workspace.
 *
 * Called from `WorkspaceService.create()` in the same transaction as handbook
 * pages and consent purposes, so a reader never lands in an empty forms list.
 */
export async function seedStarterForms(
  tx: Transaction,
  input: SeedStarterFormsInput,
): Promise<void> {
  const listIdsBySlug = new Map<StarterListSlug, string>()

  for (const list of STARTER_LISTS) {
    const id = input.createId('list')
    await listsRepository.insertList(tx, {
      id,
      workspaceId: input.workspaceId,
      name: list.name,
      description: null,
      targetType: list.targetType,
    })
    listIdsBySlug.set(list.slug as StarterListSlug, id)
  }

  for (const form of STARTER_FORMS) {
    const formId = input.createId('form')
    await formsRepository.insertForm(tx, {
      id: formId,
      workspaceId: input.workspaceId,
      name: form.name,
      title: form.title,
      description: form.description,
      status: 'active',
      thankYouMessage: form.thankYouMessage,
      publicKey: input.generatePublicKey(),
    })

    await formsRepository.insertFields(
      tx,
      form.fields.map((field, index) => {
        const consentPurposeIds =
          field.consentPurposeSlug === undefined
            ? []
            : (() => {
                const purposeId = input.consentPurposeIdsBySlug[field.consentPurposeSlug]
                if (purposeId === undefined) {
                  throw new Error(
                    `Starter form ${form.slug} names unknown consent purpose ${field.consentPurposeSlug}`,
                  )
                }
                return [purposeId]
              })()

        return {
          id: input.createId('formField'),
          workspaceId: input.workspaceId,
          formId,
          label: field.label,
          type: field.type,
          required: field.required,
          mapTo: field.mapTo,
          options: [],
          placeholder: field.placeholder ?? null,
          statement: field.statement ?? null,
          consentPurposeIds,
          consentPurposeLabels: {},
          sortOrder: index,
        }
      }),
    )

    const linkedListId =
      form.linkedListSlug === undefined ? undefined : listIdsBySlug.get(form.linkedListSlug)

    if (form.linkedListSlug !== undefined && linkedListId === undefined) {
      throw new Error(`Starter form ${form.slug} names unknown list ${form.linkedListSlug}`)
    }

    if (linkedListId !== undefined) {
      await formsRepository.replaceFormLists(tx, input.workspaceId, formId, [linkedListId])
    }
  }
}
