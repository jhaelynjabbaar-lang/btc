import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AccessDisabled } from "@/components/db-states";
import { CostInputsForm, ImportBraiinsButton, RefreshNetworkButton } from "@/components/financials-console";
import { Badge, PageHeader, Panel } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { ago, fmtUtc } from "@/lib/format";
import { BRAIINS_FEE_SOURCE_URL, BRAIINS_MONITORING_DOCS_URL, BRAIINS_POOL_FEE_PCT, NETWORK_SOURCE_URL } from "@/lib/profit/config";
import { fmtBtcFromSats, fmtHashrate, fmtNum, fmtSats, fmtUsd, orUnavailable } from "@/lib/profit/format";
import type { WorkerFinancial } from "@/lib/profit/math";
import { ensureFreshSnapshot, loadFinancials, type FinancialsView } from "@/lib/profit/service";
import { supabaseConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Financials" };
export const dynamic = "force-dynamic";

const th = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-faint";
const td = "px-3 py-2 align-top text-xs text-ink";
const link = "text-electric-hi underline decoration-dotted underline-offset-2 hover:text-neon";

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-2 text-sm last:border-0">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
  );
}
const Unavailable = ({ code }: { code?: string }) => (
  <span className="text-warn">
    unavailable{code ? <span className="ml-1 font-mono text-[10px] text-faint">({code})</span> : null}
  </span>
);
const Unknown = ({ why }: { why: string[] }) => (
  <span className="text-warn" title={why.join("; ")}>
    unknown<span className="ml-1 text-[10px] text-faint">(needs: {why.join(", ")})</span>
  </span>
);
const EstimateBadge = () => <Badge tone="warn">Estimate</Badge>;

function Disclaimer() {
  return (
    <div className="mb-6 rounded-xl border border-warn/40 bg-warn/10 p-4 text-xs leading-relaxed text-warn" role="note">
      <strong className="font-semibold">Read this first.</strong> <strong>Estimates</strong> are expectations computed from measured hashrate and public network data. They are
      not earnings, they are never added to <strong>Confirmed</strong> figures, and mining is not confirmed until the pool has verified accepted shares. CPU and GPU mining on today&apos;s
      Bitcoin network yields essentially nothing, so a tiny or negative number below is the honest result, not an error. Nothing here is financial advice.
    </div>
  );
}

function NetworkPanel({ v, refreshFailed }: { v: FinancialsView; refreshFailed: boolean }) {
  const s = v.network.snapshot;
  const fe = s?.field_errors ?? {};
  const badge =
    v.network.freshness === "fresh" ? <Badge tone="ok">Fresh</Badge> : v.network.freshness === "stale" ? <Badge tone="warn">STALE</Badge> : v.network.freshness === "unusable" ? <Badge tone="danger">Too old — not used</Badge> : <Badge tone="muted">No data</Badge>;
  return (
    <Panel title="Network data" badge={badge} className="lg:col-span-1">
      {!s ? (
        <p className="text-sm text-muted">
          Network data is <Unavailable />. No snapshot has been stored yet{refreshFailed ? " and the last fetch failed" : ""}. Without it no estimate can be calculated.
        </p>
      ) : (
        <>
          <dl>
            <Row k="Block height">{s.block_height === null ? <Unavailable code={fe.block_height} /> : s.block_height.toLocaleString("en-US")}</Row>
            <Row k="Difficulty">{s.difficulty === null ? <Unavailable code={fe.difficulty} /> : `${(s.difficulty / 1e12).toFixed(2)} T`}</Row>
            <Row k="Network hashrate">{s.network_hashrate_hs === null ? <Unavailable code={fe.network_hashrate} /> : fmtHashrate(s.network_hashrate_hs)}</Row>
            <Row k="Block subsidy">{s.subsidy_sats === null ? <Unavailable code={fe.subsidy} /> : `${(s.subsidy_sats / 1e8).toFixed(8)} BTC`}</Row>
            <Row k={`Average fees / block${s.fee_window_blocks ? ` (last ${s.fee_window_blocks})` : ""}`}>{s.avg_fee_sats === null ? <Unavailable code={fe.avg_fee} /> : `${fmtNum(s.avg_fee_sats)} sats`}</Row>
            <Row k="BTC price (USD)">
              {s.btc_price_usd === null ? (
                <Unavailable code={fe.price} />
              ) : (
                <>
                  {fmtUsd(s.btc_price_usd)}
                  <span className="ml-1 text-[10px] text-faint">
                    {s.price_source} · {fmtUtc(s.price_time)}
                  </span>
                </>
              )}
            </Row>
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            Source: <a className={link} href={NETWORK_SOURCE_URL} target="_blank" rel="noreferrer">{s.source}</a> (public, keyless). Fetched {fmtUtc(s.fetched_at)} ({ago(s.fetched_at)}).
            {v.network.freshness === "stale" && <span className="text-warn"> These numbers are older than 1 hour; estimates built on them are marked stale.</span>}
            {v.network.freshness === "unusable" && <span className="text-danger"> Older than 24 hours: shown only as the last known values; estimates are withheld.</span>}
            {s.price_source && s.price_source !== s.source && <span className="text-warn"> Price came from {s.price_source} because {s.source} failed.</span>}
            {refreshFailed && <span className="text-warn"> The latest automatic refresh failed or was partial.</span>}
          </p>
        </>
      )}
      <div className="mt-4 flex justify-end">
        <RefreshNetworkButton />
      </div>
    </Panel>
  );
}

function WorkerRows({ w, v }: { w: WorkerFinancial; v: FinancialsView }) {
  const stale = v.network.freshness === "stale";
  const r = w.revenue;
  return (
    <tr className="border-t border-line/60">
      <td className={td}>
        <div className="font-medium">{w.name}</div>
        <div className="text-[10px] text-faint">{w.hardware_type} · {w.status}</div>
      </td>
      <td className={td}>
        {w.hashrate ? (
          <>
            {fmtHashrate(w.hashrate.avgHs)}
            <div className="text-[10px] text-faint">measured, 24 h avg of {w.hashrate.buckets} min buckets ({w.hashrate.coveragePct.toFixed(1)}% of the day)</div>
          </>
        ) : (
          <span className="text-warn">no telemetry in 24 h</span>
        )}
      </td>
      <td className={td}>
        {r.ok ? (
          <>
            <div>{fmtSats(r.estimate.netSatsPerDay)}/day</div>
            <div className="text-[10px] text-faint">{fmtBtcFromSats(r.estimate.netSatsPerDay)} · {orUnavailable(r.estimate.netUsdPerDay, fmtUsd)}/day{stale ? " · STALE network data" : ""}</div>
          </>
        ) : r.reason === "no_telemetry" ? (
          <span className="text-warn">no estimate (no measured hashrate)</span>
        ) : (
          <span className="text-warn">no estimate (network data unavailable)</span>
        )}
      </td>
      <td className={td}>
        {w.cloud.resourceCount > 0 ? (
          <>
            {w.cloud.usdPerDay === null ? <Unknown why={["cloud price"]} /> : `${fmtUsd(w.cloud.usdPerDay)}/day`}
            <div className="text-[10px] text-faint">cloud · projection (hourly × 24)</div>
          </>
        ) : w.electricity.applies ? (
          w.electricity.usdPerDay === null ? <Unknown why={w.electricity.missing} /> : <>{fmtUsd(w.electricity.usdPerDay)}/day<div className="text-[10px] text-faint">electricity</div></>
        ) : (
          <Unknown why={w.netMissing.filter((m) => m.includes("cloud"))} />
        )}
      </td>
      <td className={td}>{w.netUsdPerDay === null ? <Unknown why={w.netMissing} /> : <strong className={w.netUsdPerDay < 0 ? "text-danger" : "text-ink"}>{fmtUsd(w.netUsdPerDay)}/day</strong>}</td>
    </tr>
  );
}

function EstimatePanel({ v }: { v: FinancialsView }) {
  const { fleet, workers } = v.financials;
  const stale = v.network.freshness === "stale";
  return (
    <Panel title="Profitability" badge={<EstimateBadge />} className="lg:col-span-2">
      <p className="mb-3 text-xs leading-relaxed text-muted">
        Expected BTC per day = (worker hashrate ÷ network hashrate) × 144 blocks × (subsidy + average fees), minus the pool fee of {fmtNum(v.poolFee.pct)}%
        {v.poolFee.source === "braiins-docs" ? (
          <> (Braiins&apos; documented pool fee, <a className={link} href={BRAIINS_FEE_SOURCE_URL} target="_blank" rel="noreferrer">source</a>; override it in the cost inputs if your pool differs)</>
        ) : (
          <> (your override; Braiins documents {BRAIINS_POOL_FEE_PCT}%)</>
        )}
        . Hashrate is only what telemetry measured over the last 24 h, so an unreported worker has no estimate. This is an expectation, not an earning.
        {stale && <span className="text-warn"> Built on STALE network data.</span>}
      </p>
      <div className="mb-4 rounded-lg border border-line bg-void/40 p-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-faint">
          Fleet <EstimateBadge />
        </div>
        {fleet.workersWithEstimate === 0 ? (
          <p className="text-sm text-muted">
            No estimate: {workers.length === 0 ? "no workers are enrolled." : "no worker has reported measured hashrate in the last 24 hours, or network data is unavailable."} No number is shown instead of a made-up one.
          </p>
        ) : (
          <dl>
            <Row k={`Workers with an estimate / without`}>{fleet.workersWithEstimate} / {fleet.workersWithoutEstimate}</Row>
            <Row k="Estimated revenue (after pool fee)">
              {fmtSats(fleet.revenueNetSatsPerDay as number)}/day <span className="text-[11px] text-faint">({fmtBtcFromSats(fleet.revenueNetSatsPerDay as number)})</span>
            </Row>
            <Row k="Estimated revenue in USD">{fleet.revenueNetUsdPerDay === null ? <Unavailable code="no BTC price" /> : `${fmtUsd(fleet.revenueNetUsdPerDay)}/day`}</Row>
            <Row k="Electricity (estimated workers)">{fleet.electricityUsdPerDay === null ? <Unknown why={["electricity price", "watts"]} /> : `${fmtUsd(fleet.electricityUsdPerDay)}/day`}</Row>
            <Row k="Cloud (projection, all running resources)">
              {fleet.cloud.usdPerDay === null ? <Unknown why={["cloud price"]} /> : fleet.cloud.resourceCount === 0 ? "none running" : `${fmtUsd(fleet.cloud.usdPerDay)}/day`}
            </Row>
            <Row k="Net (estimate) = revenue − costs">
              {fleet.netUsdPerDay === null ? <Unknown why={fleet.netMissing} /> : <strong className={fleet.netUsdPerDay < 0 ? "text-danger" : "text-ink"}>{fmtUsd(fleet.netUsdPerDay)}/day</strong>}
            </Row>
          </dl>
        )}
      </div>
      {workers.length === 0 ? (
        <p className="text-sm text-muted">No workers enrolled yet. Enroll one on the Workers page; nothing is shown until real telemetry exists.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="min-w-full">
            <thead className="bg-panel-hi/60">
              <tr>
                <th className={th}>Worker</th>
                <th className={th}>Measured hashrate</th>
                <th className={th}>Revenue (estimate)</th>
                <th className={th}>Cost</th>
                <th className={th}>Net (estimate)</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => (
                <WorkerRows key={w.id} w={w} v={v} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ConfirmedPanel({ v }: { v: FinancialsView }) {
  const c = v.confirmed;
  return (
    <Panel title="Earnings" badge={<Badge tone="ok">Confirmed</Badge>} className="lg:col-span-2">
      <p className="mb-3 text-xs text-muted">Only ledger rows of type <span className="font-mono">confirmed_payout</span> that come from the pool or the chain and carry a reference (payout id / txid). Estimates never appear here.</p>
      {c.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-hi/70 bg-void/40 p-4 text-sm text-muted">No confirmed payouts recorded. Confirmed earnings: <strong className="text-ink">none yet</strong>.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="min-w-full">
              <thead className="bg-panel-hi/60">
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Amount</th>
                  <th className={th}>Source</th>
                  <th className={th}>Reference</th>
                </tr>
              </thead>
              <tbody>
                {c.rows.map((r) => (
                  <tr key={r.id} className="border-t border-line/60">
                    <td className={td}>{fmtUtc(r.occurredAt)}</td>
                    <td className={td}>{fmtSats(r.amountSats)} <span className="text-[10px] text-faint">({fmtBtcFromSats(r.amountSats)})</span></td>
                    <td className={td}>{r.source}</td>
                    <td className={td + " max-w-[18rem] truncate font-mono text-[11px]"} title={r.ref}>{r.ref}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-ink">Total confirmed: <strong>{fmtSats(c.totalSats as number)}</strong> <span className="text-[11px] text-faint">({fmtBtcFromSats(c.totalSats as number)}, from the {c.rows.length} row(s) above only)</span></p>
        </>
      )}
    </Panel>
  );
}

function PoolPanel({ v }: { v: FinancialsView }) {
  const p = v.pool;
  return (
    <Panel title="Pool connection" badge={<Badge tone="info">Pool-reported</Badge>} className="lg:col-span-1">
      {!p.connected ? (
        <div className="text-sm text-muted">
          <p><strong className="text-ink">Not connected.</strong> The pool&apos;s own balance, payouts and shares are not imported, so nothing is claimed about them.</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs">
            <li>In Braiins Pool open <em>Settings → Access Profiles</em>, pick a profile and enable <em>Allow access to web APIs</em>, then <em>Generate New token</em> (<a className={link} href={BRAIINS_MONITORING_DOCS_URL} target="_blank" rel="noreferrer">docs</a>).</li>
            <li>In the Vercel dashboard, add the environment variable <span className="font-mono">BRAIINS_POOL_TOKEN</span> (Production) and redeploy. This app never creates or shows it.</li>
            <li>Reload this page.</li>
          </ol>
        </div>
      ) : !p.ok ? (
        <p className="text-sm text-warn" role="alert">Token set, but the pool data is <Unavailable code={p.error} />. Nothing is shown rather than stale numbers.</p>
      ) : (
        <>
          <dl>
            <Row k="Account">{p.profile.username ?? "—"}</Row>
            <Row k="Shares accepted, last 24 h">{fmtNum(p.profile.shares24h)}</Row>
            <Row k={`Hashrate 24 h (${p.profile.hashRateUnit})`}>{fmtNum(p.profile.hashRate24h)}</Row>
            <Row k="Current balance">{p.profile.currentBalanceBtc.toFixed(8)} BTC</Row>
            <Row k="Reward today">{p.profile.todayRewardBtc.toFixed(8)} BTC</Row>
            <Row k="All-time reward">{p.profile.allTimeRewardBtc.toFixed(8)} BTC</Row>
          </dl>
          <p className="mt-3 text-xs text-muted">
            {p.profile.shares24h > 0 || p.profile.shares5m > 0 ? (
              <span className="text-ok">The pool reports accepted shares for this account.</span>
            ) : (
              <span className="text-warn">The pool reports no accepted shares in the last 24 h. Mining is not verified.</span>
            )}{" "}
            Pool-reported at {fmtUtc(p.profile.fetchedAt)}; balances are shown here only and are not added to the Confirmed table.
          </p>
          <div className="mt-3">
            <ImportBraiinsButton />
          </div>
        </>
      )}
    </Panel>
  );
}

export default async function Page() {
  const access = await requirePageAccess("/financials");
  const header = (
    <PageHeader
      eyebrow="Profitability"
      title="Financials"
      subtitle="Public network data, labeled estimates from measured hashrate, and confirmed earnings from the pool or chain. Estimated and confirmed figures are never combined."
    />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  if (!supabaseConfigured()) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-dashed border-line-hi/70 bg-void/40 p-6 text-sm text-muted">
          <Badge tone="warn">Supabase not configured</Badge>
          <p className="mt-3">Set <span className="font-mono text-xs">SUPABASE_URL</span> and <span className="font-mono text-xs">SUPABASE_SECRET_KEY</span> to use Financials. Nothing is shown until real data exists.</p>
        </div>
      </>
    );
  }
  const refresh = await ensureFreshSnapshot();
  let view: FinancialsView;
  try {
    view = await loadFinancials(access.actor);
  } catch {
    return (
      <>
        {header}
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-5 text-sm text-warn" role="alert">
          The profitability tables could not be queried. Check that the Phase 8 migration was applied and the Supabase key is valid.
        </div>
      </>
    );
  }
  const workerLite = view.financials.workers.map((w) => ({ id: w.id, name: w.name }));
  return (
    <>
      {header}
      <Disclaimer />
      <div className="grid gap-4 lg:grid-cols-3">
        <NetworkPanel v={view} refreshFailed={refresh.failed} />
        <EstimatePanel v={view} />
        <CostInputsForm
          key={view.settings.updatedAt ?? "unset"}
          electricityUsdPerKwh={view.settings.electricityUsdPerKwh}
          defaultWattsPerWorker={view.settings.defaultWattsPerWorker}
          workerWatts={view.settings.workerWatts}
          poolFeePctOverride={view.settings.poolFeePctOverride}
          poolFeeDocumentedPct={BRAIINS_POOL_FEE_PCT}
          workers={workerLite}
        />
        <div className="lg:col-span-3 grid gap-4 lg:grid-cols-3">
          <ConfirmedPanel v={view} />
          <PoolPanel v={view} />
        </div>
      </div>
      <p className="mt-6 text-[11px] leading-relaxed text-faint">
        Sources: network data from mempool.space public APIs (CoinGecko only as a labeled price fallback); pool fee from <a className={link} href={BRAIINS_FEE_SOURCE_URL} target="_blank" rel="noreferrer">Braiins docs</a>;
        cloud costs are declared hourly prices from the Cloud page (projection, not billing). Formula and economics: <span className="font-mono">docs/profitability.md</span>.
      </p>
    </>
  );
}
