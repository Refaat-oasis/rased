// RASED Trends & Analytics shared types and contracts.
// See rased_analytics_plan_v2.md for architectural specifications.

export const TAXONOMY_DIMENSIONS = [
  'field',
  'category',
  'sub_category',
  'technology',
  'language',
  'system',
  'job_type'
] as const

export type TaxonomyDimension = typeof TAXONOMY_DIMENSIONS[number]

export interface TaxonomyNode {
  id: string
  parentId: string | null
  dimension: TaxonomyDimension
  nameAr: string
  nameEn: string
  isActive: boolean
  sortOrder: number
}

export type KeywordMatchMode = 'word' | 'phrase' | 'prefix'

export interface TaxonomyKeyword {
  id: string
  nodeId: string
  keyword: string
  weight: number
  matchMode: KeywordMatchMode
  caseSensitive: boolean
  requiresContext: string | null
  isExclusion: boolean
}

export interface TaxonomyInference {
  sourceNodeId: string
  targetNodeId: string
  confidence: number
}

export type LabelSource = 'rule' | 'inferred' | 'user'

export interface ProjectLabel {
  projectId: number
  nodeId: string
  dimension: TaxonomyDimension
  isPrimary: boolean
  score: number
  source: LabelSource
}

export type NlpClassificationStatus = 'ok' | 'low_confidence' | 'user_fixed' | 'out_of_scope'

export interface ProjectNlpState {
  projectId: number
  textHash: string
  taxonomyVersion: number
  confidence: number
  status: NlpClassificationStatus
  dupGroupId: string | null
  classifiedAt: number
}

// ---------------------------------------------------------------- Pull Policy (Phase 1)

export const PULL_POLICY_MODES = ['interval', 'times', 'both', 'manual'] as const
export type PullPolicyMode = typeof PULL_POLICY_MODES[number]

export const PULL_INTERVAL_FLOOR_SECONDS = 60
export const PULL_INTERVAL_DEFAULT_SECONDS = 300
export const PULL_INTERVAL_WARN_SECONDS = 120

export interface PullPolicy {
  platform: string
  mode: PullPolicyMode
  intervalSeconds: number
  activeFrom: string | null
  activeTo: string | null
  offHoursIntervalSeconds: number | null
  adaptive: boolean
  adaptiveMaxSeconds: number
  jitterPct: number
  isEnabled: boolean
  updatedAt: number
}

export interface PullSchedule {
  id: string
  label: string | null
  timeOfDay: string
  daysOfWeek: string
  platformsJson: string
  isEnabled: boolean
  graceMinutes: number
  nextDueAt: number | null
  lastTriggeredAt: number | null
  createdAt: number
}

export type PullRunTrigger = 'scheduled_time' | 'manual_refresh' | 'interval'
export type PullRunStatus = 'running' | 'completed' | 'partial_error' | 'failed' | 'missed' | 'skipped_backoff'

export interface PullRun {
  id: string
  scheduleId: string | null
  platform: string
  triggerType: PullRunTrigger
  startedAt: number
  completedAt: number | null
  status: PullRunStatus
  totalFetched: number
  newProjectsCount: number
  errorSummary: string | null
}

export interface PullStatsHourly {
  hourStart: number
  platform: string
  pulls: number
  newProjects: number
  errors: number
}

// ---------------------------------------------------------------- Job Status & Outcomes (Phase 2)

export const CANONICAL_PROJECT_STATUSES = [
  'open',
  'awarded',
  'completed',
  'closed_no_hire',
  'removed',
  'unknown'
] as const

export type CanonicalProjectStatus = typeof CANONICAL_PROJECT_STATUSES[number]

export interface ProjectStatusRow {
  projectId: number
  status: CanonicalProjectStatus
  statusRaw: string | null
  firstStatus: string | null
  changedAt: number | null
  proposalsCount: number | null
  lastCheckedAt: number | null
  nextCheckAt: number | null
  checksCount: number
}

// ---------------------------------------------------------------- Filters & Exploration

export type AnalyticsTimeRangeKind =
  | 'last_7_days'
  | 'this_week'
  | 'last_week'
  | 'last_30_days'
  | 'last_90_days'
  | 'custom'

export interface AnalyticsFilterPayload {
  range: AnalyticsTimeRangeKind
  customFrom?: string
  customTo?: string
  platforms?: string[]
  fieldIds?: string[]
  categoryIds?: string[]
  subCategoryIds?: string[]
  technologyIds?: string[]
  systemIds?: string[]
  jobTypeIds?: string[]
  statuses?: CanonicalProjectStatus[]
  keyword?: string
}
