import type { ChangeEvent } from 'react'

import { usePublicConfig } from '../../api/resources/publicConfig.ts'
import { regionHref } from './regionHref.ts'

/**
 * A region picker for signed-out pages.
 *
 * Hidden unless public config lists two or more origins. Selecting another
 * region leaves this origin: the session cookie is host-scoped, so the
 * browser has to load the other host's login page. Path, query, and hash
 * stay, so `/login?next=` and invite tokens survive the hop.
 */

export function RegionSwitcher(): React.JSX.Element | null {
  const { config } = usePublicConfig()
  const regions = config?.regions ?? []

  if (regions.length < 2) {
    return null
  }

  const current = regions.find((region) => region.origin === window.location.origin)

  function change(event: ChangeEvent<HTMLSelectElement>): void {
    const selected = regions.find((region) => region.id === event.target.value)

    if (selected === undefined || selected.origin === window.location.origin) {
      return
    }

    window.location.assign(regionHref(selected.origin, window.location))
  }

  return (
    <label className="mt-6 block w-full max-w-sm">
      <span className="mb-1.5 block text-[12px] font-medium text-ink">Region</span>
      <select
        className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
        value={current?.id ?? ''}
        onChange={change}
      >
        {current === undefined && (
          <option value="" disabled>
            Select a region
          </option>
        )}
        {regions.map((region) => (
          <option key={region.id} value={region.id}>
            {region.label}
          </option>
        ))}
      </select>
    </label>
  )
}
