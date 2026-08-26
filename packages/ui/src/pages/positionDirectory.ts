import { useMemo } from 'react'

import { useCompanies } from '../api/resources/companies.ts'
import { usePositions } from '../api/resources/positions.ts'

/**
 * Titles and company names for the people on screen, and head counts for the
 * companies on screen.
 *
 * A list row needs data from three resources, and `api.md` has no
 * include-expansion. What it does have is repeatable id filters, so each of
 * these asks about exactly the rows the page is rendering: two extra requests
 * for the page, not one per row, and no cap that a real workspace could grow
 * past.
 *
 * Both hold their request back until the ids are known. Asking with the filter
 * omitted would answer with every record in the workspace, which is the wrong
 * answer rather than a slow one.
 */

/** `api.md`: `?limit=` and an id filter both max out at 200. */
const MAX_PAGE = 200

export interface PeopleDirectory {
  /** The first title a person holds, matching the mockup's primary position. */
  titleFor(personId: string): string | undefined
  companyNamesFor(personId: string): readonly string[]
  readonly isLoading: boolean
  /**
   * False when these people hold more positions than one page could return.
   * Rare, and the page says so rather than leaving a cell blank, because a blank
   * that means "we did not look" reads the same as one that means "no company".
   */
  readonly isComplete: boolean
}

export function usePeopleDirectory(personIds: readonly string[]): PeopleDirectory {
  const enabled = personIds.length > 0
  const positions = usePositions({ personIds, limit: MAX_PAGE }, { enabled })
  const companies = useCompanies({ personIds, limit: MAX_PAGE }, { enabled })

  const companyNameById = useMemo(
    () => new Map(companies.records.map((company) => [company.id, company.name])),
    [companies.records],
  )

  const byPerson = useMemo(() => {
    const grouped = new Map<string, { title: string; companyId: string }[]>()

    for (const position of positions.records) {
      const held = grouped.get(position.personId) ?? []

      held.push({ title: position.title, companyId: position.companyId })
      grouped.set(position.personId, held)
    }

    return grouped
  }, [positions.records])

  return {
    titleFor: (personId) => byPerson.get(personId)?.[0]?.title,
    companyNamesFor: (personId) =>
      (byPerson.get(personId) ?? [])
        .map((held) => companyNameById.get(held.companyId))
        .filter((name): name is string => name !== undefined),
    isLoading: positions.isLoading || companies.isLoading,
    isComplete: !positions.hasNext && !companies.hasNext,
  }
}

export interface CompanyHeadcounts {
  countFor(companyId: string): number
  readonly isLoading: boolean
  readonly isComplete: boolean
}

export function useCompanyHeadcounts(companyIds: readonly string[]): CompanyHeadcounts {
  const positions = usePositions(
    { companyIds, limit: MAX_PAGE },
    { enabled: companyIds.length > 0 },
  )

  const countByCompany = useMemo(() => {
    const counts = new Map<string, number>()

    for (const position of positions.records) {
      counts.set(position.companyId, (counts.get(position.companyId) ?? 0) + 1)
    }

    return counts
  }, [positions.records])

  return {
    countFor: (companyId) => countByCompany.get(companyId) ?? 0,
    isLoading: positions.isLoading,
    isComplete: !positions.hasNext,
  }
}
