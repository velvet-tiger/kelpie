import type { ModuleSetting } from '@kelpie/schemas'

import { useSetModuleEnabled, useModuleSettings } from '../../api/resources/moduleSettings.ts'
import { useSession } from '../../api/resources/session.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'

/**
 * Turns optional modules on or off for this workspace.
 *
 * A module a deploy-time config file locks (`modules.md`) shows as disabled
 * with a note rather than being left out of the list: a workspace admin should
 * see that the choice exists and is not theirs, not wonder why a module they
 * expect is simply missing from the page.
 *
 * Known ids get a friendlier label; an id this page has never heard of still
 * renders, title-cased, because the module catalog is meant to grow without
 * this file changing every time it does.
 */
const MODULE_LABELS: Readonly<Record<string, string>> = {
  positions: 'Positions',
  deals: 'Deals',
  opportunities: 'Opportunities',
  partnerships: 'Partnerships',
  raises: 'Fundraising',
  hiring: 'Hiring',
  handbook: 'Handbook',
  forms: 'Forms',
  'import-export': 'Import / export',
  'agent-tasks': 'Agent tasks',
  webhooks: 'Webhooks',
}

function labelFor(moduleId: string): string {
  return (
    MODULE_LABELS[moduleId] ??
    moduleId
      .split('-')
      .map((word) => (word.length === 0 ? word : word[0]?.toUpperCase() + word.slice(1)))
      .join(' ')
  )
}

export function ModulesPage(): React.JSX.Element {
  const { session } = useSession()
  const { settings, isLoading, error } = useModuleSettings()
  const isAdmin = session?.role === 'owner' || session?.role === 'admin'

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Modules"
        description="Turn optional parts of Kelpie on or off for this workspace."
      />

      {error !== null && <ErrorPanel error={error} />}

      {isLoading ? (
        <LoadingPanel label="Loading modules…" />
      ) : settings.length === 0 ? (
        <p className="text-[13px] text-ink-muted">Nothing here yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {settings
            .toSorted((a, b) => labelFor(a.moduleId).localeCompare(labelFor(b.moduleId)))
            .map((setting) => (
              <ModuleRow key={setting.moduleId} setting={setting} canEdit={isAdmin} />
            ))}
        </ul>
      )}
    </div>
  )
}

function ModuleRow({
  setting,
  canEdit,
}: {
  readonly setting: ModuleSetting
  readonly canEdit: boolean
}): React.JSX.Element {
  const setEnabled = useSetModuleEnabled()
  const disabled = !canEdit || setting.locked || setEnabled.isPending

  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div>
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={setting.enabled}
            disabled={disabled}
            onChange={(event) => {
              setEnabled.run({ moduleId: setting.moduleId, enabled: event.target.checked })
            }}
            className="disabled:opacity-50"
          />
          <span className="text-[13px] font-medium text-ink">{labelFor(setting.moduleId)}</span>
        </label>
        {setting.locked && (
          <p className="mt-1 pl-6 text-[11px] text-ink-faint">
            Locked by this deployment's configuration.
          </p>
        )}
        {setEnabled.error !== null && (
          <div className="mt-2 pl-6">
            <ErrorPanel error={setEnabled.error} />
          </div>
        )}
      </div>
    </li>
  )
}
