import { SOCIAL_NETWORK_LABELS } from '@kelpie/schemas'
import type { SocialNetworkId } from '@kelpie/schemas'
import {
  siBluesky,
  siCrunchbase,
  siFacebook,
  siGithub,
  siInstagram,
  siMastodon,
  siMedium,
  siSubstack,
  siThreads,
  siTiktok,
  siWellfound,
  siX,
  siYoutube,
} from 'simple-icons'

export interface SocialNetworkIconProps {
  readonly network: SocialNetworkId
  readonly className?: string
}

/**
 * Simple Icons does not ship LinkedIn. This is the standard "in" mark used to
 * identify a LinkedIn profile, not a substitute brand colour lockup.
 */
const LINKEDIN_PATH =
  'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z'

/** Generic link glyph for the catch-all network. Heroicons MIT, 24 solid. */
const OTHER_PATH =
  'M12.232 4.232a2.5 2.5 0 0 1 3.536 3.536l-1.225 1.224a.75.75 0 0 0 1.061 1.06l1.224-1.224a4 4 0 0 0-5.656-5.656l-3 3a4 4 0 0 0 .225 5.865.75.75 0 0 0 .977-1.138 2.5 2.5 0 0 1-.142-3.667l3-3ZM11.768 19.768a2.5 2.5 0 0 1-3.536-3.536l1.225-1.224a.75.75 0 0 0-1.061-1.06l-1.224 1.224a4 4 0 1 0 5.656 5.656l3-3a4 4 0 0 0-.225-5.865.75.75 0 0 0-.977 1.138 2.5 2.5 0 0 1 .142 3.667l-3 3Z'

const ICON_PATHS: Readonly<Record<SocialNetworkId, string>> = {
  angellist: siWellfound.path,
  bluesky: siBluesky.path,
  crunchbase: siCrunchbase.path,
  facebook: siFacebook.path,
  github: siGithub.path,
  instagram: siInstagram.path,
  linkedin: LINKEDIN_PATH,
  mastodon: siMastodon.path,
  medium: siMedium.path,
  substack: siSubstack.path,
  threads: siThreads.path,
  tiktok: siTiktok.path,
  twitter: siX.path,
  youtube: siYoutube.path,
  other: OTHER_PATH,
}

/**
 * Brand mark for a social network. Decorative when the network name sits next
 * to it; fill follows the surrounding text colour so light and dark both work.
 */
export function SocialNetworkIcon({
  network,
  className,
}: SocialNetworkIconProps): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={['shrink-0', className ?? 'size-3.5'].join(' ')}
    >
      <path fill="currentColor" d={ICON_PATHS[network]} />
    </svg>
  )
}

export interface SocialNetworkNameProps {
  readonly network: SocialNetworkId
  readonly className?: string
}

/** Icon plus the display name, for pickers and compact chips. */
export function SocialNetworkName({
  network,
  className,
}: SocialNetworkNameProps): React.JSX.Element {
  return (
    <span className={['inline-flex items-center gap-1.5', className ?? ''].join(' ')}>
      <SocialNetworkIcon network={network} />
      <span>{SOCIAL_NETWORK_LABELS[network]}</span>
    </span>
  )
}
