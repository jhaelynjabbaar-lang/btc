/**
 * Roadmap stage for each capability that is not built yet.
 * Single source of truth for the "coming in Stage N" labels shown in the UI.
 * (Built so far: network status, AI backend, research engine, vulnerability feed, code scanner.)
 */
export const STAGES = {
  database: 6,
  research: 6,
  reports: 6,
  monitoring: 7,
  vulnerabilities: 5,
  engine: 4,
  scanner: 5,
} as const;

export type StageKey = keyof typeof STAGES;
