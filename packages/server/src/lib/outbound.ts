import { BlockedEgressError } from './egress.ts'
import { describeCauseForLog, describeThrownWithCause, hasErrorCode } from './errors.ts'

/**
 * What a POST to a customer's URL that threw comes to: the reason a person of
 * the workspace may read, and what only the server log may hold.
 *
 * Shared by the webhook and the agent-task senders, so both name a fault the
 * same way and both keep addresses out of the reason.
 */
export interface OutboundFailure {
  /** For the delivery log or the run: the fault by its code, never an address. */
  readonly reason: string
  /**
   * True when the fault is Kelpie's and not the endpoint's: the resolver of
   * the deployment did not answer (`EAI_AGAIN`). A caller does not hold it
   * against the endpoint.
   */
  readonly kelpieFault: boolean
  /** The address the egress guard refused. Server log only. */
  readonly blockedAddress?: string
  /** The whole cause, addresses included. Server log only. */
  readonly logDetail?: string
}

/** DNS answered "try again": the resolver Kelpie uses failed, not the endpoint's name. */
const RESOLVER_FAILURE_CODE = 'EAI_AGAIN'

export function describeOutboundFailure(error: unknown): OutboundFailure {
  const logDetail = describeCauseForLog(error)

  return {
    reason: describeThrownWithCause(error),
    kelpieFault: hasErrorCode(error, RESOLVER_FAILURE_CODE),
    ...(error instanceof BlockedEgressError ? { blockedAddress: error.address } : {}),
    ...(logDetail === undefined ? {} : { logDetail }),
  }
}
