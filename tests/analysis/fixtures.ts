import type { RawAggregate, RawData, RawWorker } from "@/lib/analysis/context";

export const NOW = new Date("2026-11-01T12:00:00.000Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

export const W1 = "11111111-1111-4111-8111-111111111111"; // high reject rate + drop
export const W2 = "22222222-2222-4222-8222-222222222222"; // healthy
export const W3 = "33333333-3333-4333-8333-333333333333"; // stale heartbeat
export const W4 = "44444444-4444-4444-8444-444444444444"; // mildly below own baseline
export const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const worker = (id: string, name: string, status: string, seen: number | null): RawWorker => ({
  id,
  name,
  status,
  hardware_type: "cpu",
  current_hashrate_hs: 1000,
  last_seen_at: seen === null ? null : minsAgo(seen),
});
const agg = (worker_id: string, o: Partial<RawAggregate>): RawAggregate => ({
  worker_id,
  recent_buckets: 60,
  recent_avg_hs: 1000,
  recent_accepted: 950,
  recent_rejected: 10,
  recent_max_temp_c: 61,
  base_buckets: 5000,
  base_avg_hs: 1000,
  base_accepted: 90000,
  base_rejected: 900,
  last_bucket: minsAgo(1),
  ...o,
});

export const EMPTY: RawData = { workers: [], aggregates: [], commands: [], providers: [], resources: [], limits: [], killSwitchEngaged: false, cloudExpensesUsd: null };

export const FULL: RawData = {
  workers: [worker(W1, "test-rig-1", "online", 1), worker(W2, "test-rig-2", "online", 1), worker(W3, "test-rig-3", "online", 45), worker(W4, "test-rig-4", "online", 2)],
  aggregates: [
    agg(W1, { recent_avg_hs: 400, recent_accepted: 80, recent_rejected: 20 }), // 12-20% reject => 100 shares, 20% ; -60% hashrate
    agg(W2, {}),
    agg(W3, {}),
    agg(W4, { recent_avg_hs: 800 }), // -20%
  ],
  commands: [{ worker_id: W1, command: "pause", status: "acked", created_at: minsAgo(300) }],
  providers: [{ id: P1, name: "Test Provider", mining_policy: "allowed_with_conditions", conditions_acknowledged: false, written_permission_recorded: false }],
  resources: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", provider_id: P1, label: "test-box", state: "running", cost_known: true, hourly_price_usd: 0.1, state_changed_at: minsAgo(100), created_at: minsAgo(2000) }],
  limits: [
    { scope: "global", provider_id: null, period: "month", limit_usd: 80, enabled: true },
    { scope: "provider", provider_id: P1, period: "month", limit_usd: 80, enabled: true },
  ],
  killSwitchEngaged: false,
  cloudExpensesUsd: null,
};
