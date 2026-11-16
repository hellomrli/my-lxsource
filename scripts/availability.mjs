/** Expected upstream outages are distinct from configuration or program errors. */
export class AvailabilityError extends Error {
  constructor(stage, message) {
    super(message)
    this.name = 'AvailabilityError'
    this.stage = stage
  }
}

export const UNAVAILABLE_EXIT_CODE = 2

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

export function upstreamUnavailable(error) {
  if (NETWORK_CODES.has(error?.code) || error?.name === 'AbortError') return true
  if (error instanceof AggregateError && error.errors.length) return error.errors.every(upstreamUnavailable)
  return /^(?:Download )?HTTP (?:403|404|408|410|425|429|5\d\d)(?:\b|$)/.test(error?.message || '') ||
    /^HTTP (?:deadline exceeded|body interrupted|request cancelled)$/.test(error?.message || '')
}
