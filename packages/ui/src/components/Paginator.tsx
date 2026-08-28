import type { Paged } from '../api/resource.ts'

/**
 * Prev / Next with a page indicator and an optional page size selector.
 *
 * The API is cursor-only (`api.md`), so there is no total count and no jump
 * to page N. `pageIndex` is one-based on screen but zero-based in `Paged` —
 * the label adds one so page 1 does not read as page 0.
 *
 * `Prev` disables when nothing came before, `Next` when the server said the
 * current page was the last one. A cached prior page is instant; going past
 * the fetched set kicks off exactly one fetch, and both buttons hold their
 * disabled state until it settles so a fast double click does not skip two.
 */

export interface PaginatorProps {
  readonly list: Paged
  /** Options offered by the page size selector. Omit to hide the selector. */
  readonly pageSizes?: readonly number[]
  /**
   * Where on the list this paginator sits. `top` places it above the rows —
   * the per-page selector then defers to the `bottom` copy so the two do not
   * duplicate the same control side by side.
   */
  readonly placement?: 'top' | 'bottom'
}

const DEFAULT_PAGE_SIZES: readonly number[] = [25, 50, 100, 200]

const buttonClass =
  'rounded-md border border-border bg-surface-raised px-2.5 py-1 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-surface-raised'

export function Paginator({
  list,
  pageSizes = DEFAULT_PAGE_SIZES,
  placement = 'bottom',
}: PaginatorProps): React.JSX.Element {
  const prevDisabled = !list.hasPrev || list.isChangingPage
  const nextDisabled = !list.hasNext || list.isChangingPage
  const options = pageSizes.includes(list.pageSize) ? pageSizes : [...pageSizes, list.pageSize].sort((a, b) => a - b)
  const showPageSize = placement === 'bottom' && pageSizes.length > 0
  const wrapperClass =
    placement === 'top'
      ? 'mt-3 mb-3 flex flex-wrap items-center gap-3 text-[12px] text-ink-muted'
      : 'mt-3 flex flex-wrap items-center gap-3 text-[12px] text-ink-muted'

  return (
    <div className={wrapperClass}>
      <div className="flex items-center gap-1">
        <button type="button" onClick={list.prevPage} disabled={prevDisabled} className={buttonClass}>
          Prev
        </button>
        <button type="button" onClick={list.nextPage} disabled={nextDisabled} className={buttonClass}>
          {list.isChangingPage ? 'Loading…' : 'Next'}
        </button>
      </div>
      <span aria-live="polite">Page {list.pageIndex + 1}</span>
      {showPageSize && (
        <label className="ml-auto flex items-center gap-2">
          <span>Per page</span>
          <select
            value={list.pageSize}
            onChange={(event) => {
              list.setPageSize(Number(event.target.value))
            }}
            className="rounded-md border border-border bg-surface-raised px-2 py-1 text-[12px] outline-none focus:border-accent"
          >
            {options.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
