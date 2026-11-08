import { boundedNumber } from './http.mjs'

/** Inspection and playback use the same, separate URL and audio deadlines. */
export function playbackPolicy(config = {}) {
  return {
    requestTimeoutMs: boundedNumber(config.embed?.requestTimeoutMs ?? config.health?.requestTimeoutMs, 12000),
    verifyTimeoutMs: boundedNumber(config.embed?.verifyTimeoutMs ?? config.health?.verifyTimeoutMs, 8000),
    totalTimeoutMs: boundedNumber(config.embed?.totalTimeoutMs, 45000),
    cooldownMs: boundedNumber(config.embed?.cooldownMs, 30000, 0, 300000),
  }
}
