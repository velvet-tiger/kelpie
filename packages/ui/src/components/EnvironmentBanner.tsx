import { usePublicConfig } from '../api/resources/publicConfig.ts'

/**
 * A thin strip above the app that names the site.
 *
 * Renders nothing on production, whether or not a site name was set: the
 * banner exists to tell dev, demo, and any other non-production install
 * apart. Renders nothing while the metadata is loading or on error either,
 * so a slow config request never pushes the app down half a second after
 * boot.
 *
 * Mounted at the top of `KelpieApp`, above the router, so it shows on the
 * sign-in and onboarding pages as well as the main app.
 */

export function EnvironmentBanner(): React.JSX.Element | null {
  const { config } = usePublicConfig()

  if (config === undefined || config.runtimeMode === 'production') {
    return null
  }

  const label = config.siteName ?? config.runtimeMode

  return (
    <div className="flex h-5 shrink-0 items-center justify-center bg-accent px-2 text-[11px] font-medium tracking-wide text-accent-fg uppercase">
      {label}
    </div>
  )
}
