import { usePublicConfig } from '../api/resources/publicConfig.ts'
import { environmentTone, type EnvironmentTone } from './environmentTone.ts'

/**
 * A thin strip above the app that names the site and paints it in a colour
 * that belongs to that name.
 *
 * Renders nothing on production, whether or not a site name was set: the
 * banner exists to tell dev, demo, cloud, and any other non-production
 * install apart. Colour does the first half of that work; the label does
 * the rest. Renders nothing while the metadata is loading or on error
 * either, so a slow config request never pushes the app down half a
 * second after boot.
 *
 * Mounted at the top of `KelpieApp`, above the router, so it shows on the
 * sign-in and onboarding pages as well as the main app.
 */

const TONE_CLASSES: Readonly<Record<EnvironmentTone, string>> = {
  dev: 'bg-env-dev text-env-dev-fg',
  demo: 'bg-env-demo text-env-demo-fg',
  staging: 'bg-env-staging text-env-staging-fg',
  test: 'bg-env-test text-env-test-fg',
  cloud: 'bg-env-cloud text-env-cloud-fg',
}

export function EnvironmentBanner(): React.JSX.Element | null {
  const { config } = usePublicConfig()

  if (config === undefined || config.runtimeMode === 'production') {
    return null
  }

  const label = config.siteName ?? config.runtimeMode
  const tone = environmentTone(label)

  const className = [
    'flex h-5 shrink-0 items-center justify-center px-2 text-[11px] font-medium tracking-wide uppercase',
    TONE_CLASSES[tone],
  ].join(' ')

  return (
    <div data-tone={tone} className={className}>
      {label}
    </div>
  )
}
