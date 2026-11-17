import { type PullPolicy, PULL_INTERVAL_FLOOR_SECONDS } from '../shared/trends.js'
import { type SchedulerState, MIN_REST_MS } from './scheduler.js'

export interface PullContext {
  nowMs: number
  lastStartMs: number | null
  lastFinishMs: number | null
  consecutiveZeroNewPulls: number
  random?: () => number
}

/**
 * Checks whether the given hour and minute (0..23, 0..59) fall within active hours [from, to].
 * Both strings are 'HH:MM'. Supports overnight windows (e.g. 22:00 to 06:00).
 */
export function isInsideActiveHours(
  from: string,
  to: string,
  currentHour: number,
  currentMinute: number
): boolean {
  const [fromH, fromM] = from.split(':').map(Number)
  const [toH, toM] = to.split(':').map(Number)
  if (fromH === undefined || fromM === undefined || toH === undefined || toM === undefined) {
    return true
  }

  const currentTotal = currentHour * 60 + currentMinute
  const fromTotal = fromH * 60 + fromM
  const toTotal = toH * 60 + toM

  if (fromTotal <= toTotal) {
    return currentTotal >= fromTotal && currentTotal <= toTotal
  }
  // Overnight range, e.g. 22:00 -> 06:00
  return currentTotal >= fromTotal || currentTotal <= toTotal
}

/**
 * Computes delay in milliseconds until the next pull cycle for a given policy and state.
 * Returns -1 if paused or disabled.
 */
export function computeNextPullDelay(
  policy: PullPolicy,
  schedulerState: SchedulerState,
  context: PullContext
): number {
  if (schedulerState.paused || !policy.isEnabled) return -1

  // 1. Backoff ladder always wins when active
  if (schedulerState.backoffUntilMs !== null && context.nowMs < schedulerState.backoffUntilMs) {
    return schedulerState.backoffUntilMs - context.nowMs
  }

  if (context.lastStartMs === null) return 0

  // 2. Safe floor enforcement (minimum 60 seconds)
  let intervalSec = Math.max(PULL_INTERVAL_FLOOR_SECONDS, policy.intervalSeconds)

  // 3. Active hours check
  if (policy.activeFrom && policy.activeTo) {
    const d = new Date(context.nowMs)
    const inside = isInsideActiveHours(policy.activeFrom, policy.activeTo, d.getHours(), d.getMinutes())
    if (!inside) {
      if (policy.offHoursIntervalSeconds && policy.offHoursIntervalSeconds > 0) {
        intervalSec = Math.max(PULL_INTERVAL_FLOOR_SECONDS, policy.offHoursIntervalSeconds)
      } else {
        // Paused outside active hours; calculate ms until activeFrom
        const [fromH, fromM] = policy.activeFrom.split(':').map(Number)
        if (fromH !== undefined && fromM !== undefined) {
          const nextActive = new Date(context.nowMs)
          nextActive.setHours(fromH, fromM, 0, 0)
          if (nextActive.getTime() <= context.nowMs) {
            nextActive.setDate(nextActive.getDate() + 1)
          }
          return Math.max(0, nextActive.getTime() - context.nowMs)
        }
      }
    }
  }

  // 4. Adaptive stretching when consecutive pulls discover 0 new items
  if (policy.adaptive && context.consecutiveZeroNewPulls > 0) {
    const stretchFactor = Math.pow(1.5, Math.min(context.consecutiveZeroNewPulls, 4))
    const stretched = Math.round(intervalSec * stretchFactor)
    intervalSec = Math.min(stretched, policy.adaptiveMaxSeconds)
  }

  // 5. Jitter application (default ±10%)
  const rnd = context.random ?? Math.random
  const jitterFactor = policy.jitterPct > 0
    ? 1 - (policy.jitterPct / 100) + (rnd() * ((policy.jitterPct * 2) / 100))
    : 1
  const intervalMs = Math.round(intervalSec * 1000 * jitterFactor)

  // 6. Rest period enforcement
  const earliest = Math.max(
    context.lastStartMs + intervalMs,
    (context.lastFinishMs ?? context.lastStartMs) + MIN_REST_MS
  )

  return Math.max(0, earliest - context.nowMs)
}
