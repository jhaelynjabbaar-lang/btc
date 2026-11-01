/** Phase 7 analysis constants. No I/O, no secrets. Shared by the context builder, the prompt, the UI and the tests. */

export const JOB_TYPES = ["worker_health", "efficiency", "cloud_spend"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JOB_LABEL: Record<JobType, string> = {
  worker_health: "Worker health",
  efficiency: "Efficiency",
  cloud_spend: "Cloud & spend",
};

/** Windows the telemetry aggregates are computed over (the baseline is the worker's OWN earlier history). */
export const WINDOWS = { recent_minutes: 60, baseline_days: 7, command_history_days: 7, ledger_days: 30 } as const;

/** Deterministic thresholds. A "signal" only exists when one is crossed; the model is never asked to find anomalies in raw rows. */
export const THRESHOLDS = {
  stale_heartbeat_minutes: 10,
  reject_rate_high_pct: 5,
  min_shares_for_rate: 20,
  hashrate_drop_pct: 40,
  underperform_pct: 15,
  reject_rate_vs_baseline_x: 2,
  min_reject_rate_pct_for_baseline_compare: 2,
  min_recent_buckets: 5,
  min_baseline_buckets: 60,
  min_baseline_shares: 100,
  cap_near_pct: 80,
  pending_approval_stale_hours: 24,
} as const;

/** Hard size limits: keep prompts and completions small and bounded. */
export const BUDGET = {
  maxEntitiesPerSection: 12,
  maxFactsPerSection: 90,
  maxContextChars: 9000,
  maxCompletionTokens: 3000,
  modelTimeoutMs: 60_000,
  maxRecommendations: 8,
  reasoningEffort: "low" as const,
} as const;

/** One manual run per minute (counted from the durable audit log, so it holds across serverless instances). */
export const MANUAL_RUN_COOLDOWN_MS = 60_000;

export const HOURS_PER_MONTH = 730; // identical to lib/cloud/guard.ts (projection from declared hourly prices)

export const SEVERITIES = ["info", "warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** App vocabulary <-> stored vocabulary (the Phase 2 CHECK constraint is left untouched). */
export const STATUS_FROM_DB = { pending: "proposed", approved: "accepted", rejected: "dismissed" } as const;
export type RecStatus = (typeof STATUS_FROM_DB)[keyof typeof STATUS_FROM_DB];
