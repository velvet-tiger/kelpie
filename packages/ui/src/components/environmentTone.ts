export type EnvironmentTone = 'dev' | 'demo' | 'staging' | 'test' | 'cloud'

const NAMED_TONES: Readonly<Record<string, EnvironmentTone>> = {
  development: 'dev',
  dev: 'dev',
  local: 'dev',
  demo: 'demo',
  staging: 'staging',
  stage: 'staging',
  preview: 'staging',
  test: 'test',
  cloud: 'cloud',
}

const TONES: readonly EnvironmentTone[] = ['dev', 'demo', 'staging', 'test', 'cloud']

/**
 * Picks a banner colour from a site name or runtime-mode fallback.
 *
 * Known names keep a stable colour so four tabs (dev, demo, cloud, staging)
 * never collide. Anything else hashes onto the same five colours so an
 * unknown name still looks different from local.
 */
export function environmentTone(label: string): EnvironmentTone {
  const key = label.trim().toLowerCase()
  const named = NAMED_TONES[key]
  if (named !== undefined) {
    return named
  }

  return TONES[hashLabel(key) % TONES.length] ?? 'dev'
}

function hashLabel(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return hash
}
