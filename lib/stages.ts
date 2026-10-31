/**
 * Roadmap stage for each capability that is not built yet.
 * Single source of truth for the "coming in Stage N" labels shown in the UI.
 */
export const STAGES = {
  database: 3,
  vulnerabilities: 4,
  monitoring: 5,
  engine: 6,
  scanner: 7,
  research: 8,
  reports: 8,
} as const;

export type StageKey = keyof typeof STAGES;
