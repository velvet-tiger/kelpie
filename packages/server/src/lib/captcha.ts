/**
 * The port a CAPTCHA vendor plugs into. Core has no vendor code: a module
 * registers a named provider with `context.provideCaptcha(name, build)`, and
 * the deployment picks one with the `CAPTCHA_PROVIDER` variable. Unset means no
 * CAPTCHA, which is the default.
 *
 * The same registry pattern as `lib/email.ts`, with one difference: there is no
 * built-in provider, so `context.captcha.current()` answers `undefined` on a
 * deployment that picked none.
 *
 * The one consumer today is the forms module's spam check. The port is not in
 * that module because a sign-up page has the same need.
 */

/**
 * What a page needs to draw the vendor's widget.
 *
 * The vendors share one browser API shape: a script that defines a global, and
 * `window[globalName].render(element, { sitekey, callback })`, where the
 * callback receives the response string the server verifies. Turnstile,
 * hCaptcha and reCAPTCHA v2 all work this way, so a page can draw any of them
 * from this description and holds no vendor name.
 */
export interface CaptchaWidget {
  /** The vendor script, loaded with a `<script src>`. Use the explicit-render form of the URL. */
  readonly scriptUrl: string
  /** The global the script defines: `turnstile`, `hcaptcha`, `grecaptcha`. */
  readonly globalName: string
  /** The public site key. Not a secret: it is in every page that shows the widget. */
  readonly siteKey: string
  /**
   * The origins the widget needs in a page's Content-Security-Policy. A page
   * with a strict policy, such as the form embed, adds these and nothing more.
   */
  readonly contentSecurityPolicy: {
    readonly scriptSrc: readonly string[]
    readonly frameSrc: readonly string[]
    readonly connectSrc: readonly string[]
    readonly styleSrc?: readonly string[]
  }
}

export interface CaptchaProvider {
  readonly widget: CaptchaWidget
  /**
   * Asks the vendor whether `response` is a solved challenge for this site.
   *
   * @returns false when the vendor refuses the response.
   * @throws when the vendor cannot be reached. The caller decides what an
   *   outage means; the forms module lets the submit through.
   */
  verify(response: string): Promise<boolean>
}

/** What a consumer module holds. Read `current()` at request time, never inside `register`. */
export interface CaptchaAccess {
  /** The provider the deployment picked, or undefined when it picked none. */
  current(): CaptchaProvider | undefined
}

/** The variable that names the provider. Empty or unset: no CAPTCHA. */
export const CAPTCHA_PROVIDER_VARIABLE = 'CAPTCHA_PROVIDER'
