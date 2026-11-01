import type { SnapshotRow } from "@/lib/paper/service";

const W = 720;
const H = 240;
const PAD = { l: 52, r: 12, t: 12, b: 24 };

/** Server-rendered SVG equity curve: the bot vs simply holding BTC (both paper money). Real recorded snapshots only. */
export function EquityChart({ snapshots }: { snapshots: SnapshotRow[] }) {
  if (snapshots.length < 2) {
    return <p className="text-sm text-muted">Not enough data yet ({snapshots.length} hourly snapshot{snapshots.length === 1 ? "" : "s"}). The curve appears after the second hourly tick.</p>;
  }
  const t0 = new Date(snapshots[0].candle_start).getTime();
  const t1 = new Date(snapshots[snapshots.length - 1].candle_start).getTime();
  const vals = snapshots.flatMap((s) => [s.equity_usd, s.bench_equity_usd]);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 0.02) {
    lo -= 0.01;
    hi += 0.01;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const line = (key: "equity_usd" | "bench_equity_usd") => snapshots.map((s) => `${x(new Date(s.candle_start).getTime()).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const day = (t: number) => new Date(t).toISOString().slice(5, 16).replace("T", " ") + "Z";
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Paper equity curve: bot versus buy and hold" className="h-auto w-full">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-line" strokeDasharray="3 4" />
            <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" className="fill-current text-faint" fontSize="10">
              ${v.toFixed(2)}
            </text>
          </g>
        ))}
        <polyline points={line("bench_equity_usd")} fill="none" stroke="currentColor" className="text-warn" strokeWidth="1.5" />
        <polyline points={line("equity_usd")} fill="none" stroke="currentColor" className="text-neon" strokeWidth="2" />
        <text x={PAD.l} y={H - 6} className="fill-current text-faint" fontSize="10">
          {day(t0)}
        </text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" className="fill-current text-faint" fontSize="10">
          {day(t1)}
        </text>
      </svg>
      <div className="mt-2 flex gap-4 text-xs text-muted">
        <span>
          <span className="mr-1 inline-block h-2 w-4 rounded-sm bg-neon align-middle" />
          Bot (paper)
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-4 rounded-sm bg-warn align-middle" />
          Buy &amp; hold BTC (paper)
        </span>
      </div>
    </div>
  );
}
