import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AccessDisabled } from "@/components/db-states";
import { EquityChart } from "@/components/paper-chart";
import { PaperControls } from "@/components/paper-console";
import { Badge, PageHeader, Panel } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { fmtUtc } from "@/lib/format";
import { configFromEnv, DATA_SOURCE, DATA_SOURCE_URL, DEFAULT_CONFIG, PAPER_LABEL, PRODUCT, type PaperConfig } from "@/lib/paper/config";
import { loadPaperView, type PaperView } from "@/lib/paper/service";
import { summarize } from "@/lib/paper/summary";
import { supabaseConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Paper Trading" };
export const dynamic = "force-dynamic";

const th = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-faint";
const td = "px-3 py-2 align-top text-xs text-ink";
const money = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const px = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number | null) => (n === null ? "n/a" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%");
const tone = (n: number) => (n > 0 ? "text-ok" : n < 0 ? "text-danger" : "text-ink");

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-2 text-sm last:border-0">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
  );
}

function Banner() {
  return (
    <div className="mb-6 rounded-xl border border-warn/40 bg-warn/10 p-4 text-xs leading-relaxed text-warn" role="note">
      <strong className="font-semibold uppercase tracking-wide">{PAPER_LABEL}.</strong> Everything on this page is a simulation with fake money and live public prices. No exchange account, API key,
      wallet or real order is involved. Fees, slippage and minimum order sizes are modelled so the result is honest, but past or simulated results do not predict real results, and with a
      balance this small trading costs can easily outweigh gains. Nothing here is financial advice. Risk of loss is real if this is ever turned into real trading; that step is not built.
    </div>
  );
}

function Params({ c }: { c: PaperConfig }) {
  return (
    <Panel title="Strategy &amp; costs" badge={<Badge tone="warn">{PAPER_LABEL}</Badge>}>
      <p className="mb-3 text-xs text-muted">
        Long-only SMA trend filter on hourly {PRODUCT} closes. Hold BTC while the fast average is above the slow average (by more than the band); hold USD while it is below (by more than the
        band); otherwise keep the current state. Decisions use closed candles only and the whole balance is used per trade. See docs/paper-trading.md.
      </p>
      <dl>
        <Row k="Fast / slow SMA">
          {c.fast} / {c.slow} hourly candles
        </Row>
        <Row k="Dead band">{(c.bandBps / 100).toFixed(2)}% around slow SMA</Row>
        <Row k="Taker fee">{(c.feeBps / 100).toFixed(2)}% of each fill (rounded up to the cent)</Row>
        <Row k="Slippage">{(c.slippageBps / 100).toFixed(2)}% adverse, on top of the real bid/ask</Row>
        <Row k="Minimum order">{money(c.minOrderCents / 100)} notional (exchange minimum for {PRODUCT})</Row>
        <Row k="Starting balance">{money(c.startCents / 100)} (paper)</Row>
        <Row k="Schedule">hourly at minute :05 UTC (Vercel cron), once per closed candle</Row>
        <Row k="Price source">
          <a className="text-electric-hi underline decoration-dotted underline-offset-2 hover:text-neon" href={`${DATA_SOURCE_URL}/products/${PRODUCT}/ticker`} target="_blank" rel="noreferrer">
            {DATA_SOURCE}
          </a>
          <span className="ml-1 text-[10px] text-faint">keyless, read-only</span>
        </Row>
      </dl>
    </Panel>
  );
}

function Body({ v }: { v: PaperView }) {
  const run = v.run;
  if (!run) {
    return (
      <Panel title="No paper run yet">
        <p className="text-sm text-muted">
          Nothing has been recorded. The hourly cron starts a run automatically with the defaults below at its first tick, or start one now from the controls.
        </p>
      </Panel>
    );
  }
  const latest = v.snapshots.length ? v.snapshots[v.snapshots.length - 1] : null;
  const s = summarize(run.starting_usd, run.cash_usd, run.qty_btc, latest?.price ?? null, latest);
  const c = { ...DEFAULT_CONFIG, ...run.config };
  const posValue = latest ? run.qty_btc * latest.price : null;
  const buys = v.trades.filter((t) => t.side === "buy").length;
  const sells = v.trades.filter((t) => t.side === "sell").length;
  const realized = v.closedPositions.reduce((a, p) => a + (p.pnl_usd ?? 0), 0);
  return (
    <>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Cash (paper USD)" value={money(run.cash_usd)} sub={`started with ${money(run.starting_usd)}`} />
        <Stat label="Equity (paper)" value={money(s.equity)} sub={`${pct(s.botReturnPct)} vs start`} cls={tone(s.equity - run.starting_usd)} />
        <Stat label="Buy & hold (paper)" value={money(s.benchEquity)} sub={`${pct(s.benchReturnPct)} · bot is ${s.vsHoldUsd >= 0 ? "ahead" : "behind"} by ${money(Math.abs(s.vsHoldUsd))}`} cls={tone(s.benchEquity - run.starting_usd)} />
        <Stat label="Total fees paid" value={money(run.fees_paid_usd)} sub={`${buys} buys · ${sells} sells (last 100 trades)`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Equity vs buy &amp; hold" badge={<Badge tone="warn">{PAPER_LABEL}</Badge>} className="lg:col-span-2">
          <EquityChart snapshots={v.snapshots} />
          <p className="mt-2 text-[11px] text-faint">
            Both lines are marked to the last recorded {PRODUCT} price (no exit costs applied to either). Buy &amp; hold buys at the run&apos;s first tick with the same fee, slippage and minimums.
          </p>
        </Panel>
        <Panel title="Status" badge={run.paused ? <Badge tone="warn">Paused</Badge> : <Badge tone="ok">Running</Badge>}>
          <dl>
            <Row k="Run started">{fmtUtc(run.created_at)}</Row>
            <Row k="Last candle processed">{fmtUtc(run.last_candle_at)}</Row>
            <Row k="Last price used">
              {latest ? (
                <>
                  {px(latest.price)}
                  <span className="ml-1 text-[10px] text-faint">
                    {latest.price_source} · {fmtUtc(latest.price_time)}
                  </span>
                </>
              ) : (
                "none yet"
              )}
            </Row>
            <Row k="Last decision">{latest ? `${latest.action} (${latest.signal})` : "none yet"}</Row>
            <Row k="Realized P&L (closed trades)">
              <span className={tone(realized)}>{money(realized)}</span>
            </Row>
            <Row k="Archived earlier runs">{v.archivedRuns}</Row>
          </dl>
          {latest && <p className="mt-3 text-[11px] leading-relaxed text-faint">{latest.reason}</p>}
        </Panel>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Open position">
          {v.position ? (
            <dl>
              <Row k="Size">{v.position.qty_btc.toFixed(8)} BTC</Row>
              <Row k="Entry fill">{px(v.position.entry_price)}</Row>
              <Row k="Cost incl. fee">{money(v.position.cost_usd)}</Row>
              <Row k="Opened">{fmtUtc(v.position.opened_at)}</Row>
              <Row k="Marked value">{posValue === null ? "n/a" : money(posValue)}</Row>
              <Row k="Unrealized">
                {posValue === null ? "n/a" : <span className={tone(posValue - v.position.cost_usd)}>{money(posValue - v.position.cost_usd)}</span>}
              </Row>
            </dl>
          ) : (
            <p className="text-sm text-muted">No open position: the bot is holding paper USD.</p>
          )}
        </Panel>
        <div className="lg:col-span-2">
          <Panel title="Trade log">
            {v.trades.length === 0 ? (
              <p className="text-sm text-muted">No trades yet. The bot only trades when the strategy signals, so none is normal.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse">
                  <thead>
                    <tr>
                      <th className={th}>Time</th>
                      <th className={th}>Side</th>
                      <th className={th}>Qty (BTC)</th>
                      <th className={th}>Quote</th>
                      <th className={th}>Fill</th>
                      <th className={th}>Notional</th>
                      <th className={th}>Fee</th>
                      <th className={th}>Price source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.trades.map((t) => (
                      <tr key={t.id} className="border-t border-line/60">
                        <td className={td}>{fmtUtc(t.executed_at)}</td>
                        <td className={td + (t.side === "buy" ? " text-ok" : " text-danger")}>{t.side}</td>
                        <td className={td + " font-mono"}>{t.qty_btc.toFixed(8)}</td>
                        <td className={td}>{px(t.ref_price)}</td>
                        <td className={td}>{px(t.fill_price)}</td>
                        <td className={td}>{money(t.notional_usd)}</td>
                        <td className={td}>{money(t.fee_usd)}</td>
                        <td className={td + " text-faint"}>
                          {t.price_source}
                          <br />
                          {fmtUtc(t.price_time)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Params c={c} />
        <EventsPanel v={v} />
      </div>
    </>
  );
}

function EventsPanel({ v }: { v: PaperView }) {
  return (
    <Panel title="Log">
      {v.events.length === 0 ? (
        <p className="text-sm text-muted">No events.</p>
      ) : (
        <ul className="space-y-2">
          {v.events.map((e) => (
            <li key={e.id} className="text-xs text-ink">
              <span className="mr-2 text-faint">{fmtUtc(e.at)}</span>
              <Badge tone={e.level === "error" ? "danger" : e.level === "warn" ? "warn" : "muted"}>{e.kind}</Badge>
              <span className="ml-2 text-muted">{e.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-faint">Failed or implausible price fetches skip the tick and appear here. Prices are never guessed.</p>
    </Panel>
  );
}

function Stat({ label, value, sub, cls = "" }: { label: string; value: string; sub: string; cls?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel/90 p-4">
      <div className="text-[11px] uppercase tracking-[0.12em] text-faint">{label}</div>
      <div className={"mt-1 text-2xl font-semibold " + (cls || "text-ink")}>{value}</div>
      <div className="mt-1 text-[11px] text-muted">{sub}</div>
    </div>
  );
}

export default async function Page() {
  const access = await requirePageAccess("/paper");
  const header = (
    <PageHeader
      eyebrow="Simulation"
      title="Paper Trading"
      subtitle="A $5 paper-money bot trading BTC-USD on live public prices, with fees, slippage and minimum order sizes modelled. Paper money, not real."
    />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  if (!supabaseConfigured()) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-dashed border-line-hi/70 bg-void/40 p-6 text-sm text-muted">
          <Badge tone="warn">Supabase not configured</Badge>
          <p className="mt-3">Set SUPABASE_URL and SUPABASE_SECRET_KEY to use paper trading.</p>
        </div>
      </>
    );
  }
  let view: PaperView;
  try {
    view = await loadPaperView();
  } catch {
    return (
      <>
        {header}
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-5 text-sm text-warn" role="alert">
          The paper-trading tables could not be queried. Check that the paper_trading migration was applied and the Supabase key is valid.
        </div>
      </>
    );
  }
  const env = configFromEnv();
  const cfg = view.run ? { ...DEFAULT_CONFIG, ...view.run.config } : env;
  return (
    <>
      {header}
      <div className="mb-3 text-xs text-muted">
        <Link className="text-electric-hi underline decoration-dotted underline-offset-2 hover:text-neon" href="/paper/meme">
          Memecoin paper bot (separate $5 paper account) →
        </Link>
      </div>
      <Banner />
      <Body v={view} />
      {!view.run && (
        <div className="mt-4">
          <Params c={env} />
        </div>
      )}
      <div className="mt-4">
        <PaperControls hasRun={Boolean(view.run)} paused={Boolean(view.run?.paused)} defaults={{ startUsd: cfg.startCents / 100, feePct: cfg.feeBps / 100, slippagePct: cfg.slippageBps / 100 }} />
      </div>
    </>
  );
}
