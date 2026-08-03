/**
 * Light, dark, or whatever the operating system says.
 *
 * The preference is stored, the resolved value goes on `data-theme`, and
 * `styles.css` does the rest. Ported from `mockups/src/lib/theme.ts`.
 */

export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'kelpie.theme'

export function getStoredTheme(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY)

  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

export function setStoredTheme(theme: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, theme)
}

export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') {
    return preference
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(preference))
}

/** Calls back when the operating system flips, for as long as the returned function is uncalled. */
export function watchSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (): void => {
    onChange()
  }

  query.addEventListener('change', handler)

  return () => {
    query.removeEventListener('change', handler)
  }
}
