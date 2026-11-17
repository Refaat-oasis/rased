import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase, type Db } from '../src/storage/db.js'
import {
  getPullPolicy,
  savePullPolicy,
  listPullPolicies,
  listPullSchedules,
  savePullSchedule,
  deletePullSchedule,
  recordPullRun,
  recordPullStatsHourly,
  getPullStatsHourly,
  listRecentPullRuns,
  defaultPullPolicy
} from '../src/storage/pullPolicies.js'
import {
  computeNextPullDelay,
  isInsideActiveHours,
  type PullContext
} from '../src/collector/pullEngine.js'
import { initialSchedulerState } from '../src/collector/scheduler.js'
import { PULL_INTERVAL_FLOOR_SECONDS } from '../src/shared/trends.js'

let dir = ''
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rased-pull-test-'))
  db = openDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  closeDatabase(db)
  rmSync(dir, { recursive: true, force: true })
})

describe('pull policies storage', () => {
  it('returns default policy when no custom policy has been saved', () => {
    const policy = getPullPolicy(db, 'mostaql')
    expect(policy.platform).toBe('mostaql')
    expect(policy.mode).toBe('interval')
    expect(policy.intervalSeconds).toBe(300)
    expect(policy.isEnabled).toBe(true)
    expect(policy.adaptive).toBe(false)
  })

  it('saves and updates custom policy and enforces safe interval floor', () => {
    const custom = defaultPullPolicy('mostaql')
    custom.intervalSeconds = 30 // below 60s floor
    custom.adaptive = true
    custom.activeFrom = '08:00'
    custom.activeTo = '22:00'
    savePullPolicy(db, custom)

    const saved = getPullPolicy(db, 'mostaql')
    // floor of 60s should be enforced
    expect(saved.intervalSeconds).toBe(PULL_INTERVAL_FLOOR_SECONDS)
    expect(saved.adaptive).toBe(true)
    expect(saved.activeFrom).toBe('08:00')
    expect(saved.activeTo).toBe('22:00')

    const policies = listPullPolicies(db)
    expect(policies).toHaveLength(1)
    expect(policies[0]?.platform).toBe('mostaql')
  })

  it('manages fixed pull schedules', () => {
    expect(listPullSchedules(db)).toHaveLength(0)
    savePullSchedule(db, {
      id: 'sched-1',
      label: 'Morning Pull',
      timeOfDay: '09:00',
      daysOfWeek: '*',
      platformsJson: JSON.stringify(['mostaql', 'nafezly']),
      isEnabled: true,
      graceMinutes: 30,
      nextDueAt: null,
      lastTriggeredAt: null,
      createdAt: Date.now()
    })

    const list = listPullSchedules(db)
    expect(list).toHaveLength(1)
    expect(list[0]?.label).toBe('Morning Pull')
    expect(list[0]?.timeOfDay).toBe('09:00')

    expect(deletePullSchedule(db, 'sched-1')).toBe(true)
    expect(listPullSchedules(db)).toHaveLength(0)
  })

  it('records productive pull runs and aggregates hourly stats', () => {
    const now = Date.now()
    recordPullRun(db, {
      id: 'run-1',
      scheduleId: null,
      platform: 'mostaql',
      triggerType: 'interval',
      startedAt: now - 5000,
      completedAt: now,
      status: 'completed',
      totalFetched: 15,
      newProjectsCount: 4,
      errorSummary: null
    })

    const runs = listRecentPullRuns(db, 'mostaql')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.newProjectsCount).toBe(4)

    recordPullStatsHourly(db, 'mostaql', 4, 0, now)
    recordPullStatsHourly(db, 'mostaql', 2, 1, now)

    const hourStart = Math.floor(now / 3_600_000) * 3_600_000
    const stats = getPullStatsHourly(db, 'mostaql', hourStart, hourStart + 3_600_000)
    expect(stats).toHaveLength(1)
    expect(stats[0]?.pulls).toBe(2)
    expect(stats[0]?.newProjects).toBe(6)
    expect(stats[0]?.errors).toBe(1)
  })
})

describe('pull engine delay calculations', () => {
  const fixedRnd = () => 0.5 // zero jitter factor

  it('respects safe floor, interval, and last execution time', () => {
    const policy = defaultPullPolicy('mostaql')
    policy.intervalSeconds = 300 // 5 minutes
    const sched = initialSchedulerState()

    const context: PullContext = {
      nowMs: 1_000_000,
      lastStartMs: 900_000, // started 100s ago
      lastFinishMs: 910_000,
      consecutiveZeroNewPulls: 0,
      random: fixedRnd
    }

    const delay = computeNextPullDelay(policy, sched, context)
    // 300s = 300,000ms. Since 100,000ms passed, remaining delay is 200,000ms
    expect(delay).toBe(200_000)
  })

  it('handles adaptive backoff stretching when no new projects arrive', () => {
    const policy = defaultPullPolicy('mostaql')
    policy.intervalSeconds = 120 // 2 minutes
    policy.adaptive = true
    policy.adaptiveMaxSeconds = 600 // 10 minutes max
    const sched = initialSchedulerState()

    const context: PullContext = {
      nowMs: 1_000_000,
      lastStartMs: 1_000_000,
      lastFinishMs: 1_000_000,
      consecutiveZeroNewPulls: 3, // 3 empty pulls
      random: fixedRnd
    }

    const delay = computeNextPullDelay(policy, sched, context)
    // base 120s stretched by 1.5^3 = 3.375 => ~405s = 405,000ms
    expect(delay).toBeGreaterThan(120_000)
    expect(delay).toBeLessThanOrEqual(600_000)
  })

  it('checks active hours window accurately', () => {
    // 08:00 to 22:00
    expect(isInsideActiveHours('08:00', '22:00', 10, 30)).toBe(true)
    expect(isInsideActiveHours('08:00', '22:00', 7, 59)).toBe(false)
    expect(isInsideActiveHours('08:00', '22:00', 22, 1)).toBe(false)

    // overnight shift: 22:00 to 06:00
    expect(isInsideActiveHours('22:00', '06:00', 23, 0)).toBe(true)
    expect(isInsideActiveHours('22:00', '06:00', 3, 0)).toBe(true)
    expect(isInsideActiveHours('22:00', '06:00', 12, 0)).toBe(false)
  })

  it('scheduler backoff always wins over policy interval', () => {
    const policy = defaultPullPolicy('mostaql')
    policy.intervalSeconds = 120
    const sched = {
      ...initialSchedulerState(),
      backoffUntilMs: 2_000_000
    }

    const context: PullContext = {
      nowMs: 1_000_000,
      lastStartMs: 950_000,
      lastFinishMs: 960_000,
      consecutiveZeroNewPulls: 0,
      random: fixedRnd
    }

    const delay = computeNextPullDelay(policy, sched, context)
    // Backoff is at 2,000,000, so delay must be 1,000,000 ms
    expect(delay).toBe(1_000_000)
  })
})
