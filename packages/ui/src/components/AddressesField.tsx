import { formatAddress, primaryAddress } from '@kelpie/schemas'
import type { PostalAddress } from '@kelpie/schemas'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { CountrySearch } from './CountrySearch.tsx'
import { SidebarField } from './SidebarField.tsx'

export interface AddressesFieldProps<Kind extends string> {
  readonly value: readonly PostalAddress<Kind>[]
  readonly kinds: readonly Kind[]
  readonly kindLabels: Readonly<Record<Kind, string>>
  readonly onChange: (addresses: readonly PostalAddress<Kind>[]) => void
}

export interface AddressSidebarLinkProps {
  readonly addresses: readonly PostalAddress[]
  readonly onOpen: () => void
}

/**
 * The primary address as a single sidebar link. Clicking it opens the Addresses
 * tab; the editor itself does not live in the aside.
 */
export function AddressSidebarLink({
  addresses,
  onOpen,
}: AddressSidebarLinkProps): React.JSX.Element {
  const address = primaryAddress(addresses)
  const text = address === undefined ? 'Add address…' : formatAddress(address)

  return (
    <SidebarField label="Address">
      <button
        type="button"
        onClick={onOpen}
        className="text-left text-[12px] font-medium text-accent transition hover:text-accent-hover hover:underline"
      >
        {text}
      </button>
    </SidebarField>
  )
}

interface AddressDraft {
  readonly line1: string
  readonly line2: string
  readonly city: string
  readonly region: string
  readonly postalCode: string
  readonly country: string
}

function emptyDraft(): AddressDraft {
  return { line1: '', line2: '', city: '', region: '', postalCode: '', country: '' }
}

function fromAddress(address: PostalAddress): AddressDraft {
  return {
    line1: address.line1 ?? '',
    line2: address.line2 ?? '',
    city: address.city ?? '',
    region: address.region ?? '',
    postalCode: address.postalCode ?? '',
    country: address.country ?? '',
  }
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()

  return trimmed.length === 0 ? null : trimmed
}

function partsFromDraft(draft: AddressDraft): {
  readonly line1: string | null
  readonly line2: string | null
  readonly city: string | null
  readonly region: string | null
  readonly postalCode: string | null
  readonly country: string | null
} {
  return {
    line1: blankToNull(draft.line1),
    line2: blankToNull(draft.line2),
    city: blankToNull(draft.city),
    region: blankToNull(draft.region),
    postalCode: blankToNull(draft.postalCode),
    country: blankToNull(draft.country),
  }
}

function draftHasLocation(draft: AddressDraft): boolean {
  return Object.values(partsFromDraft(draft)).some((part) => part !== null)
}

function withPrimary<Kind extends string>(
  addresses: readonly PostalAddress<Kind>[],
  kind: Kind,
): readonly PostalAddress<Kind>[] {
  return addresses.map((address) => ({ ...address, primary: address.kind === kind }))
}

function withoutKind<Kind extends string>(
  addresses: readonly PostalAddress<Kind>[],
  kind: Kind,
): readonly PostalAddress<Kind>[] {
  const next = addresses.filter((address) => address.kind !== kind)

  if (next.length === 0 || next.some((address) => address.primary)) {
    return next
  }

  return next.map((address, index) => ({ ...address, primary: index === 0 }))
}

function AddressPartInputs({
  draft,
  onChange,
}: {
  readonly draft: AddressDraft
  readonly onChange: (draft: AddressDraft) => void
}): React.JSX.Element {
  const inputClass =
    'w-full rounded-md border border-border bg-surface-raised px-2 py-1 text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

  function set(field: keyof AddressDraft, value: string): void {
    onChange({ ...draft, [field]: value })
  }

  return (
    <div className="space-y-1.5">
      <input
        value={draft.line1}
        onChange={(event) => {
          set('line1', event.target.value)
        }}
        placeholder="Line 1"
        className={inputClass}
      />
      <input
        value={draft.line2}
        onChange={(event) => {
          set('line2', event.target.value)
        }}
        placeholder="Line 2"
        className={inputClass}
      />
      <input
        value={draft.city}
        onChange={(event) => {
          set('city', event.target.value)
        }}
        placeholder="City"
        className={inputClass}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <input
          value={draft.region}
          onChange={(event) => {
            set('region', event.target.value)
          }}
          placeholder="Region"
          className={inputClass}
        />
        <input
          value={draft.postalCode}
          onChange={(event) => {
            set('postalCode', event.target.value)
          }}
          placeholder="Postal code"
          className={inputClass}
        />
      </div>
      <CountrySearch
        value={draft.country}
        onChange={(country) => {
          set('country', country)
        }}
      />
    </div>
  )
}

/**
 * Add, edit, and remove labelled postal addresses. One entry per kind. The first
 * added address is primary; marking another one primary clears the old mark;
 * removing the primary promotes the first remaining entry.
 */
export function AddressesField<Kind extends string>({
  value,
  kinds,
  kindLabels,
  onChange,
}: AddressesFieldProps<Kind>): React.JSX.Element {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [pendingKind, setPendingKind] = useState<Kind | null>(null)
  const [pendingDraft, setPendingDraft] = useState<AddressDraft>(emptyDraft)
  const [editingKind, setEditingKind] = useState<Kind | null>(null)
  const [editDraft, setEditDraft] = useState<AddressDraft>(emptyDraft)

  const available = useMemo(() => {
    const used = new Set(value.map((address) => address.kind))

    return kinds.filter((kind) => !used.has(kind))
  }, [kinds, value])

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()

    return term.length === 0
      ? available
      : available.filter((kind) => kindLabels[kind].toLowerCase().includes(term))
  }, [available, kindLabels, query])

  useEffect(() => {
    if (!open) {
      return
    }

    function onPointerDown(event: MouseEvent): void {
      if (rootRef.current?.contains(event.target as Node) !== true) {
        setOpen(false)
        setQuery('')
      }
    }

    document.addEventListener('mousedown', onPointerDown)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  useEffect(() => {
    setHighlight(0)
  }, [query, open])

  function pickKind(kind: Kind): void {
    setEditingKind(null)
    setPendingKind(kind)
    setPendingDraft(emptyDraft())
    setOpen(false)
    setQuery('')
  }

  function cancelPending(): void {
    setPendingKind(null)
    setPendingDraft(emptyDraft())
  }

  function commitPending(): void {
    if (pendingKind === null || !draftHasLocation(pendingDraft)) {
      return
    }

    const next: PostalAddress<Kind> = {
      kind: pendingKind,
      ...partsFromDraft(pendingDraft),
      primary: value.length === 0,
    }

    onChange(value.length === 0 ? [next] : [...value.filter((address) => address.kind !== pendingKind), next])
    cancelPending()
  }

  function cancelEdit(): void {
    setEditingKind(null)
    setEditDraft(emptyDraft())
  }

  function commitEdit(): void {
    if (editingKind === null) {
      return
    }

    if (!draftHasLocation(editDraft)) {
      onChange(withoutKind(value, editingKind))
      cancelEdit()
      return
    }

    onChange(
      value.map((address) =>
        address.kind === editingKind
          ? { ...address, ...partsFromDraft(editDraft) }
          : address,
      ),
    )
    cancelEdit()
  }

  return (
    <div className="space-y-0.5">
      <ul>
        {value.map((address) => {
          const label = kindLabels[address.kind]

          if (editingKind === address.kind) {
            return (
              <li key={address.kind} className="py-1">
                <div className="mb-1 text-[11px] font-medium text-ink-muted">{label}</div>
                <AddressPartInputs draft={editDraft} onChange={setEditDraft} />
                <div className="mt-1.5 flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="rounded-md px-2 py-1 text-[11px] font-medium text-ink-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={commitEdit}
                    className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-fg hover:bg-accent-hover"
                  >
                    Save
                  </button>
                </div>
              </li>
            )
          }

          const summary = formatAddress(address)

          return (
            <li
              key={address.kind}
              className="-mx-1 rounded-md px-1 py-1 hover:bg-surface"
            >
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] leading-snug text-ink">
                    <span className="font-medium">{label}</span>
                    {address.primary && (
                      <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                        Primary
                      </span>
                    )}
                  </div>
                  {summary.length > 0 && (
                    <div className="text-[12px] leading-snug text-ink-muted">{summary}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  {!address.primary && (
                    <button
                      type="button"
                      onClick={() => {
                        onChange(withPrimary(value, address.kind))
                      }}
                      className="rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-faint hover:bg-surface-raised hover:text-ink"
                    >
                      Primary
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      cancelPending()
                      setEditingKind(address.kind)
                      setEditDraft(fromAddress(address))
                    }}
                    className="rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-faint hover:bg-surface-raised hover:text-ink"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (editingKind === address.kind) {
                        cancelEdit()
                      }

                      onChange(withoutKind(value, address.kind))
                    }}
                    className="rounded px-1 py-0.5 text-[13px] leading-none text-ink-faint hover:bg-danger-soft hover:text-danger"
                    aria-label={`Remove ${label}`}
                  >
                    ×
                  </button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      {value.length === 0 && pendingKind === null && (
        <p className="py-0.5 text-[12px] text-ink-faint">None yet</p>
      )}

      {pendingKind !== null ? (
        <div className="mt-1 space-y-1.5 rounded-md border border-border bg-surface px-2 py-2">
          <div className="text-[11px] font-medium text-ink">{kindLabels[pendingKind]}</div>
          <AddressPartInputs draft={pendingDraft} onChange={setPendingDraft} />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={cancelPending}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commitPending}
              disabled={!draftHasLocation(pendingDraft)}
              className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      ) : (
        available.length > 0 && (
          <div ref={rootRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setOpen((current) => !current)
                setQuery('')
              }}
              className="mt-0.5 -mx-1 rounded-md px-1 py-1 text-[12px] font-medium text-ink-muted transition hover:bg-surface hover:text-accent"
            >
              + Add
            </button>

            {open && (
              <div className="absolute z-20 mt-0.5 w-full overflow-hidden rounded-md border border-border bg-surface-raised">
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setHighlight((current) =>
                        Math.min(current + 1, Math.max(filtered.length - 1, 0)),
                      )
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setHighlight((current) => Math.max(current - 1, 0))
                    } else if (event.key === 'Enter') {
                      event.preventDefault()
                      const hit = filtered[highlight]

                      if (hit !== undefined) {
                        pickKind(hit)
                      }
                    } else if (event.key === 'Escape') {
                      setOpen(false)
                      setQuery('')
                    }
                  }}
                  placeholder="Search kinds…"
                  role="combobox"
                  aria-expanded={open}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  className="w-full border-b border-border px-2.5 py-1.5 text-[12px] outline-none focus:bg-accent-soft/30"
                />
                <ul id={listId} role="listbox" className="max-h-48 overflow-auto py-1">
                  {filtered.length === 0 ? (
                    <li className="px-3 py-2 text-[12px] text-ink-faint">No kinds match</li>
                  ) : (
                    filtered.map((kind, index) => (
                      <li key={kind} role="option" aria-selected={index === highlight}>
                        <button
                          type="button"
                          onMouseEnter={() => {
                            setHighlight(index)
                          }}
                          onClick={() => {
                            pickKind(kind)
                          }}
                          className={[
                            'flex w-full px-3 py-1.5 text-left text-[12px] text-ink',
                            index === highlight ? 'bg-accent-soft' : 'hover:bg-surface',
                          ].join(' ')}
                        >
                          {kindLabels[kind]}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            )}
          </div>
        )
      )}
    </div>
  )
}
