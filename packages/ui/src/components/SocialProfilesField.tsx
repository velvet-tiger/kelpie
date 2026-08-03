import { SOCIAL_NETWORK_IDS, SOCIAL_NETWORK_LABELS } from '@kelpie/schemas'
import type { SocialNetworkId, SocialProfile } from '@kelpie/schemas'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

export interface SocialProfilesFieldProps {
  readonly value: readonly SocialProfile[]
  readonly onChange: (profiles: readonly SocialProfile[]) => void
}

function hrefFor(url: string): string {
  return /^https?:\/\//iu.test(url) ? url : `https://${url}`
}

/** The path or handle, so a list of profiles does not repeat the same domain nine times. */
function profileHandle(url: string): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/iu, '').replace(/\/+$/u, '')
  const slash = bare.indexOf('/')

  if (slash === -1) {
    return bare
  }

  const path = bare.slice(slash + 1)

  return path.length > 0 ? path : bare
}

/** One profile per network, so the network list doubles as the set of things left to add. */
export function SocialProfilesField({
  value,
  onChange,
}: SocialProfilesFieldProps): React.JSX.Element {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [pendingNetwork, setPendingNetwork] = useState<SocialNetworkId | null>(null)
  const [pendingUrl, setPendingUrl] = useState('')
  const [editingNetwork, setEditingNetwork] = useState<SocialNetworkId | null>(null)
  const [editUrl, setEditUrl] = useState('')

  const available = useMemo(() => {
    const used = new Set(value.map((profile) => profile.network))

    return SOCIAL_NETWORK_IDS.filter((network) => !used.has(network))
  }, [value])

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()

    return term.length === 0
      ? available
      : available.filter((network) => SOCIAL_NETWORK_LABELS[network].toLowerCase().includes(term))
  }, [available, query])

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

  useEffect(() => {
    if (pendingNetwork !== null) {
      urlInputRef.current?.focus()
    }
  }, [pendingNetwork])

  useEffect(() => {
    if (editingNetwork !== null) {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }
  }, [editingNetwork])

  function pickNetwork(network: SocialNetworkId): void {
    setEditingNetwork(null)
    setPendingNetwork(network)
    setPendingUrl('')
    setOpen(false)
    setQuery('')
  }

  function cancelPending(): void {
    setPendingNetwork(null)
    setPendingUrl('')
  }

  function commitPending(): void {
    const url = pendingUrl.trim()

    if (pendingNetwork === null || url.length === 0) {
      return
    }

    onChange([
      ...value.filter((profile) => profile.network !== pendingNetwork),
      { network: pendingNetwork, url },
    ])
    cancelPending()
  }

  function cancelEdit(): void {
    setEditingNetwork(null)
    setEditUrl('')
  }

  function commitEdit(): void {
    if (editingNetwork === null) {
      return
    }

    const url = editUrl.trim()

    onChange(
      url.length === 0
        ? value.filter((profile) => profile.network !== editingNetwork)
        : value.map((profile) =>
            profile.network === editingNetwork ? { ...profile, url } : profile,
          ),
    )
    cancelEdit()
  }

  return (
    <div className="space-y-0.5">
      <ul>
        {value.map((profile) => {
          const label = SOCIAL_NETWORK_LABELS[profile.network]

          if (editingNetwork === profile.network) {
            return (
              <li key={profile.network} className="py-1">
                <div className="mb-1 text-[11px] font-medium text-ink-muted">{label}</div>
                <input
                  ref={editInputRef}
                  type="url"
                  value={editUrl}
                  onChange={(event) => {
                    setEditUrl(event.target.value)
                  }}
                  onBlur={commitEdit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitEdit()
                    }

                    if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelEdit()
                    }
                  }}
                  className="w-full rounded-md border border-accent bg-surface-raised px-2 py-1 text-[12px] outline-none ring-2 ring-accent/20"
                />
              </li>
            )
          }

          return (
            <li
              key={profile.network}
              className="-mx-1 flex items-center gap-1 rounded-md px-1 py-1 hover:bg-surface"
            >
              <a
                href={hrefFor(profile.url)}
                target="_blank"
                rel="noopener noreferrer"
                title={profile.url}
                className="min-w-0 flex-1 truncate text-[12px] leading-snug text-ink hover:text-accent"
              >
                <span className="font-medium">{label}</span>
                <span className="text-ink-faint"> · </span>
                <span className="text-ink-muted">{profileHandle(profile.url)}</span>
              </a>
              <div className="flex shrink-0 items-center">
                <button
                  type="button"
                  onClick={() => {
                    cancelPending()
                    setEditingNetwork(profile.network)
                    setEditUrl(profile.url)
                  }}
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-faint hover:bg-surface-raised hover:text-ink"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (editingNetwork === profile.network) {
                      cancelEdit()
                    }

                    onChange(value.filter((other) => other.network !== profile.network))
                  }}
                  className="rounded px-1 py-0.5 text-[13px] leading-none text-ink-faint hover:bg-danger-soft hover:text-danger"
                  aria-label={`Remove ${label}`}
                >
                  ×
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      {value.length === 0 && pendingNetwork === null && (
        <p className="py-0.5 text-[12px] text-ink-faint">None yet</p>
      )}

      {pendingNetwork !== null ? (
        <div className="mt-1 space-y-1.5 rounded-md border border-border bg-surface px-2 py-2">
          <div className="text-[11px] font-medium text-ink">
            {SOCIAL_NETWORK_LABELS[pendingNetwork]}
          </div>
          <input
            ref={urlInputRef}
            type="url"
            value={pendingUrl}
            onChange={(event) => {
              setPendingUrl(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitPending()
              }

              if (event.key === 'Escape') {
                event.preventDefault()
                cancelPending()
              }
            }}
            placeholder="Profile URL"
            className="w-full rounded-md border border-border bg-surface-raised px-2 py-1 text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
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
              disabled={pendingUrl.trim().length === 0}
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
                        pickNetwork(hit)
                      }
                    } else if (event.key === 'Escape') {
                      setOpen(false)
                      setQuery('')
                    }
                  }}
                  placeholder="Search networks…"
                  role="combobox"
                  aria-expanded={open}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  className="w-full border-b border-border px-2.5 py-1.5 text-[12px] outline-none focus:bg-accent-soft/30"
                />
                <ul id={listId} role="listbox" className="max-h-48 overflow-auto py-1">
                  {filtered.length === 0 ? (
                    <li className="px-3 py-2 text-[12px] text-ink-faint">No networks match</li>
                  ) : (
                    filtered.map((network, index) => (
                      <li key={network} role="option" aria-selected={index === highlight}>
                        <button
                          type="button"
                          onMouseEnter={() => {
                            setHighlight(index)
                          }}
                          onClick={() => {
                            pickNetwork(network)
                          }}
                          className={[
                            'flex w-full px-3 py-1.5 text-left text-[12px] text-ink',
                            index === highlight ? 'bg-accent-soft' : 'hover:bg-surface',
                          ].join(' ')}
                        >
                          {SOCIAL_NETWORK_LABELS[network]}
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
