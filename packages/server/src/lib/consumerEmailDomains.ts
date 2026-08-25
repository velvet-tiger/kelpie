/**
 * Consumer email hosts, checked case-insensitively.
 *
 * The email-domain listener refuses to auto-link a Person to a Company on any
 * domain in this list. A consumer address belongs to no one company, and a
 * Company row entered by mistake against, say, `gmail.com` would otherwise
 * auto-attach every consumer address after.
 *
 * A starter list of the common providers. Add locale variants and less common
 * hosts as the need arrives.
 */
const CONSUMER_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.jp',
  'yahoo.fr',
  'yahoo.de',
  'yahoo.ca',
  'yahoo.com.au',
  'ymail.com',
  'rocketmail.com',
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.fr',
  'hotmail.de',
  'hotmail.it',
  'hotmail.es',
  'outlook.com',
  'outlook.co.uk',
  'live.com',
  'live.co.uk',
  'msn.com',
  'aol.com',
  'aim.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'protonmail.com',
  'proton.me',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'mail.com',
  'fastmail.com',
  'fastmail.fm',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'tutanota.com',
  'tuta.io',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
])

export function isConsumerEmailDomain(domain: string): boolean {
  return CONSUMER_EMAIL_DOMAINS.has(domain.trim().toLowerCase())
}
