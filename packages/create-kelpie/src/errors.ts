/** A precondition failed. Reported as a message rather than a stack. */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScaffoldError'
  }
}
