import type { Db } from './db.js'
import {
  type PullPolicy,
  type PullSchedule,
  type PullRun,
  type PullStatsHourly,
  PULL_INTERVAL_DEFAULT_SECONDS,
  PULL_INTERVAL_FLOOR_SECONDS
} from '../shared/trends.js'

export function defaultPullPolicy(platform: string): PullPolicy {
  return {
    platform,
    mode: 'interval',
    intervalSeconds: PULL_INTERVAL_DEFAULT_SECONDS,
    activeFrom: null,
    activeTo: null,
    offHoursIntervalSeconds: null,
    adaptive: false,
    adaptiveMaxSeconds: 1800,
    jitterPct: 10,
    isEnabled: true,
    updatedAt: Date.now()
  }
}

export function getPullPolicy(db: Db, platform: string): PullPolicy {
  const row = db.prepare(`
    SELECT platform, mode, interval_seconds, active_from, active_to,
           off_hours_interval_seconds, adaptive, adaptive_max_seconds,
           jitter_pct, is_enabled, updated_at
    FROM pull_policy
    WHERE platform = ? OR platform = 'default'
    ORDER BY CASE WHEN platform = ? THEN 0 ELSE 1 END
    LIMIT 1;
  `).get(platform, platform) as {
    platform: string
    mode: string
    interval_seconds: number
    active_from: string | null
    active_to: string | null
    off_hours_interval_seconds: number | null
    adaptive: number
    adaptive_max_seconds: number
    jitter_pct: number
    is_enabled: number
    updated_at: number
  } | undefined

  if (!row) return defaultPullPolicy(platform)

  return {
    platform,
    mode: (row.mode as PullPolicy['mode']) || 'interval',
    intervalSeconds: Math.max(PULL_INTERVAL_FLOOR_SECONDS, row.interval_seconds),
    activeFrom: row.active_from,
    activeTo: row.active_to,
    offHoursIntervalSeconds: row.off_hours_interval_seconds,
    adaptive: row.adaptive === 1,
    adaptiveMaxSeconds: row.adaptive_max_seconds,
    jitterPct: row.jitter_pct,
    isEnabled: row.is_enabled === 1,
    updatedAt: row.updated_at
  }
}

export function savePullPolicy(db: Db, policy: PullPolicy): void {
  const safeInterval = Math.max(PULL_INTERVAL_FLOOR_SECONDS, policy.intervalSeconds)
  db.prepare(`
    INSERT INTO pull_policy (
      platform, mode, interval_seconds, active_from, active_to,
      off_hours_interval_seconds, adaptive, adaptive_max_seconds,
      jitter_pct, is_enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET
      mode = excluded.mode,
      interval_seconds = excluded.interval_seconds,
      active_from = excluded.active_from,
      active_to = excluded.active_to,
      off_hours_interval_seconds = excluded.off_hours_interval_seconds,
      adaptive = excluded.adaptive,
      adaptive_max_seconds = excluded.adaptive_max_seconds,
      jitter_pct = excluded.jitter_pct,
      is_enabled = excluded.is_enabled,
      updated_at = excluded.updated_at;
  `).run(
    policy.platform,
    policy.mode,
    safeInterval,
    policy.activeFrom,
    policy.activeTo,
    policy.offHoursIntervalSeconds,
    policy.adaptive ? 1 : 0,
    policy.adaptiveMaxSeconds,
    policy.jitterPct,
    policy.isEnabled ? 1 : 0,
    Date.now()
  )
}

export function listPullPolicies(db: Db): PullPolicy[] {
  const rows = db.prepare(`
    SELECT platform, mode, interval_seconds, active_from, active_to,
           off_hours_interval_seconds, adaptive, adaptive_max_seconds,
           jitter_pct, is_enabled, updated_at
    FROM pull_policy
    ORDER BY platform ASC;
  `).all() as {
    platform: string
    mode: string
    interval_seconds: number
    active_from: string | null
    active_to: string | null
    off_hours_interval_seconds: number | null
    adaptive: number
    adaptive_max_seconds: number
    jitter_pct: number
    is_enabled: number
    updated_at: number
  }[]

  return rows.map(r => ({
    platform: r.platform,
    mode: r.mode as PullPolicy['mode'],
    intervalSeconds: Math.max(PULL_INTERVAL_FLOOR_SECONDS, r.interval_seconds),
    activeFrom: r.active_from,
    activeTo: r.active_to,
    offHoursIntervalSeconds: r.off_hours_interval_seconds,
    adaptive: r.adaptive === 1,
    adaptiveMaxSeconds: r.adaptive_max_seconds,
    jitterPct: r.jitter_pct,
    isEnabled: r.is_enabled === 1,
    updatedAt: r.updated_at
  }))
}

export function listPullSchedules(db: Db): PullSchedule[] {
  const rows = db.prepare(`
    SELECT id, label, time_of_day, days_of_week, platforms_json,
           is_enabled, grace_minutes, next_due_at, last_triggered_at, created_at
    FROM pull_schedules
    ORDER BY time_of_day ASC;
  `).all() as {
    id: string
    label: string | null
    time_of_day: string
    days_of_week: string
    platforms_json: string
    is_enabled: number
    grace_minutes: number
    next_due_at: number | null
    last_triggered_at: number | null
    created_at: number
  }[]

  return rows.map(r => ({
    id: r.id,
    label: r.label,
    timeOfDay: r.time_of_day,
    daysOfWeek: r.days_of_week,
    platformsJson: r.platforms_json,
    isEnabled: r.is_enabled === 1,
    graceMinutes: r.grace_minutes,
    nextDueAt: r.next_due_at,
    lastTriggeredAt: r.last_triggered_at,
    createdAt: r.created_at
  }))
}

export function savePullSchedule(db: Db, schedule: PullSchedule): void {
  db.prepare(`
    INSERT INTO pull_schedules (
      id, label, time_of_day, days_of_week, platforms_json,
      is_enabled, grace_minutes, next_due_at, last_triggered_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      time_of_day = excluded.time_of_day,
      days_of_week = excluded.days_of_week,
      platforms_json = excluded.platforms_json,
      is_enabled = excluded.is_enabled,
      grace_minutes = excluded.grace_minutes,
      next_due_at = excluded.next_due_at,
      last_triggered_at = excluded.last_triggered_at;
  `).run(
    schedule.id,
    schedule.label,
    schedule.timeOfDay,
    schedule.daysOfWeek,
    schedule.platformsJson,
    schedule.isEnabled ? 1 : 0,
    schedule.graceMinutes,
    schedule.nextDueAt,
    schedule.lastTriggeredAt,
    schedule.createdAt
  )
}

export function deletePullSchedule(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM pull_schedules WHERE id = ?;').run(id)
  return result.changes > 0
}

export function recordPullRun(db: Db, run: PullRun): void {
  db.prepare(`
    INSERT INTO pull_runs (
      id, schedule_id, platform, trigger_type, started_at, completed_at,
      status, total_fetched, new_projects_count, error_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `).run(
    run.id,
    run.scheduleId,
    run.platform,
    run.triggerType,
    run.startedAt,
    run.completedAt,
    run.status,
    run.totalFetched,
    run.newProjectsCount,
    run.errorSummary
  )
}

export function recordPullStatsHourly(
  db: Db,
  platform: string,
  newProjects: number,
  errors: number,
  timestampMs = Date.now()
): void {
  const hourStart = Math.floor(timestampMs / 3_600_000) * 3_600_000
  db.prepare(`
    INSERT INTO pull_stats_hourly (hour_start, platform, pulls, new_projects, errors)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(hour_start, platform) DO UPDATE SET
      pulls = pulls + 1,
      new_projects = new_projects + excluded.new_projects,
      errors = errors + excluded.errors;
  `).run(hourStart, platform, newProjects, errors)
}

export function getPullStatsHourly(
  db: Db,
  platform: string,
  fromHourMs: number,
  toHourMs: number
): PullStatsHourly[] {
  const rows = db.prepare(`
    SELECT hour_start, platform, pulls, new_projects, errors
    FROM pull_stats_hourly
    WHERE platform = ? AND hour_start >= ? AND hour_start <= ?
    ORDER BY hour_start ASC;
  `).all(platform, fromHourMs, toHourMs) as {
    hour_start: number
    platform: string
    pulls: number
    new_projects: number
    errors: number
  }[]

  return rows.map(r => ({
    hourStart: r.hour_start,
    platform: r.platform,
    pulls: r.pulls,
    newProjects: r.new_projects,
    errors: r.errors
  }))
}

export function listRecentPullRuns(
  db: Db,
  platform?: string,
  limit = 50
): PullRun[] {
  const query = platform
    ? 'SELECT * FROM pull_runs WHERE platform = ? ORDER BY started_at DESC LIMIT ?;'
    : 'SELECT * FROM pull_runs ORDER BY started_at DESC LIMIT ?;'
  const params = platform ? [platform, limit] : [limit]

  const rows = db.prepare(query).all(...params) as {
    id: string
    schedule_id: string | null
    platform: string
    trigger_type: string
    started_at: number
    completed_at: number | null
    status: string
    total_fetched: number
    new_projects_count: number
    error_summary: string | null
  }[]

  return rows.map(r => ({
    id: r.id,
    scheduleId: r.schedule_id,
    platform: r.platform,
    triggerType: r.trigger_type as PullRun['triggerType'],
    startedAt: r.started_at,
    completedAt: r.completed_at,
    status: r.status as PullRun['status'],
    totalFetched: r.total_fetched,
    newProjectsCount: r.new_projects_count,
    errorSummary: r.error_summary
  }))
}
