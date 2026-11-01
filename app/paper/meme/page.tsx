import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AccessDisabled } from "@/components/db-states";
import { MemeControls } from "@/components/meme-console";
import { Badge, PageHeader, Panel } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { fmtUtc } from "@/lib/format";
import { DEFAULT_MEME_CONFIG, MEME_LABEL, MEME_WARNING, memeConfigFromEnv, type MemeConfig } from "@/lib/meme/config";
import { dexscreenerPairUrl } from "@/lib/meme/market";
import { loadMemeView, type MemeView, type PositionView } from "@/lib/meme/service";
import { supabaseConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Memecoin Paper Trading" };
export const dynamic = "force-dynamic";

const th = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-faint";
const td = "px-3 py-2 align-top text-xs text-ink";
const money = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tiny = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
/** Token prices span many orders of magnitude: show significant digits, not cents. */
const px = (n: number) => "$" + (n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toPrecision(4).replace(/e-(\d+)/, (_m, e) => `e-${e}`));
const pct = (n: number | null) => (n === null || !Number.isFinite(n) ? "n/a" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%");
const tone = (n: number) => (n > 0 ? "text-ok" : n < 0 ? "text-danger" : "text-ink");
const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-2 text-sm last:border-0">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
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

function Banner() {
  return (
    <div className="mb-6 rounded-xl border border-danger/40 bg-danger/10 p-4 text-xs leading-relaxed text-danger" role="note">
      <strong className="font-semibold uppercase tracking-wide">{MEME_WARNING.split(".")[0]}.</strong> {MEME_WARNING.split(".").slice(1).join(".").trim()} No wallet, private key or real order exists anywhere in this code. Modelled
      fees and slippage are estimates, and real fills on thin memecoin pools can be much worse.
    </div>
  );
}

function TokenLink({ symbol, address, pair }: { symbol: string; address: string; pair: string | null }) {
  const url = pair ? dexscreenerPairUrl(pair) : null;
  return (
    <div>
      <div className="font-medium text-ink">{symbol}</div>
      {url ? (
        <a className="font-mono text-[11px] text-electric-hi underline decoration-dotted underline-offset-2 hover:text-neon" href={url} target="_blank" rel="noreferrer noopener" title={address}>
          {shortAddr(address)} ↗ DexScreener
        </a>
      ) : (
        <span className="font-mono text-[11px] text-faint" title={address}>
          {shortAddr(address)}
        </span>
      )}
    </div>
  );
}

function Params({ c }: { c: MemeConfig }) {
  return (
    <Panel title="Rules in force" badge={<Badge tone="warn">{MEME_LABEL}</Badge>}>
      <p className="mb-3 text-xs text-muted">Momentum entries on new trending Solana tokens, only after rug checks; hard risk limits on every position. Full detail in docs/meme-paper-trading.md.</p>
      <dl>
        <Row k="Rug checks">
          liquidity ≥ ${c.minLiquidityUsd.toLocaleString()} · pool age {c.minPairAgeHours}-{c.maxPairAgeHours}h · 24h volume ≥ ${c.minVolume24hUsd.toLocaleString()}
        </Row>
        <Row k="Order flow">
          ≥ {c.minTxns1h} txns/1h · buys ≥ {c.minBuyRatio1h * 100}% (1h) / {c.minBuyRatio24h * 100}% (24h)
        </Row>
        <Row k="Momentum / not absurd">
          1h +{c.minChange1hPct}…+{c.maxChange1hPct}% · 6h {c.minChange6hPct}…+{c.maxChange6hPct}% · 24h ≤ +{c.maxChange24hPct}%
        </Row>
        <Row k="RugCheck.xyz">
          mint &amp; freeze authority renounced · score ≤ {c.maxRugcheckScore} · top holder ≤ {c.maxTopHolderPct}% · top 10 ≤ {c.maxTop10HolderPct}% (pools excluded) · fail closed if unreachable
        </Row>
        <Row k="Sizing">
          {c.positionPct * 100}% of equity per position · max {c.maxOpenPositions} open
        </Row>
        <Row k="Exits">
          stop −{c.stopLossPct}% · take-profit +{c.takeProfitPct}% · trail {c.trailPct}% after +{c.trailActivatePct}% · max hold {c.maxHoldHours}h · liquidity −{c.liquidityCollapsePct}%
        </Row>
        <Row k="Costs per trade">
          {(c.dexFeeBps / 100).toFixed(2)}% DEX fee + {c.txFeeSol} SOL tx fee + slippage ≥ {(c.slippageFloorBps / 100).toFixed(2)}% (plus price impact vs liquidity)
        </Row>
        <Row k="Schedule">every 15 minutes (Vercel cron)</Row>
        <Row k="Data">DexScreener (price, liquidity), RugCheck.xyz, GeckoTerminal (discovery); keyless, read-only</Row>
      </dl>
    </Panel>
  );
}

function OpenTable({ rows }: { rows: PositionView[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted">No open positions: the bot is holding paper cash.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse">
        <thead>
          <tr>
            <th className={th}>Token</th>
            <th className={th}>Entry fill</th>
            <th className={th}>Current</th>
            <th className={th}>Cost</th>
            <th className={th}>Value</th>
            <th className={th}>P/L</th>
            <th className={th}>Liquidity</th>
            <th className={th}>Opened / marked</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const value = p.qty * p.last_price;
            const pl = value - p.cost_usd;
            return (
              <tr key={p.id} className="border-t border-line/60">
                <td className={td}>
                  <TokenLink symbol={p.symbol} address={p.token_address} pair={p.pair_address} />
                </td>
                <td className={td + " font-mono"}>{px(p.entry_fill_price)}</td>
                <td className={td + " font-mono"}>{px(p.last_price)}</td>
                <td className={td}>{tiny(p.cost_usd)}</td>
                <td className={td}>{tiny(value)}</td>
                <td className={td + " " + tone(pl)}>
                  {tiny(pl)}
                  <br />
                  <span className="text-[11px]">{pct((value / p.cost_usd - 1) * 100)}</span>
                </td>
                <td className={td}>
                  {p.last_liquidity_usd === null ? "n/a" : "$" + Math.round(p.last_liquidity_usd).toLocaleString()}
                  <br />
                  <span className="text-[11px] text-faint">entry ${Math.round(p.entry_liquidity_usd).toLocaleString()}</span>
                </td>
                <td className={td + " text-faint"}>
                  {fmtUtc(p.opened_at)}
                  <br />
                  {p.last_marked_at ? fmtUtc(p.last_marked_at) : "n/a"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Body({ v }: { v: MemeView }) {
  const a = v.account;
  if (!a)
    return (
      <Panel title="No memecoin paper account yet">
        <p className="text-sm text-muted">Nothing has been recorded. The 15-minute cron starts an account automatically at its first tick, or start one now from the controls.</p>
      </Panel>
    );
  const marketValue = v.open.reduce((s, p) => s + p.qty * p.last_price, 0);
  const equity = a.cash_usd + marketValue;
  const realized = v.closed.reduce((s, p) => s + (p.pnl_usd ?? 0), 0);
  const lastTick = v.ticks.find((t) => t.status === "applied") ?? null;
  const wins = v.closed.filter((p) => (p.pnl_usd ?? 0) > 0).length;
  return (
    <>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Equity (paper)" value={tiny(equity)} sub={`${pct((equity / a.starting_usd - 1) * 100)} vs ${money(a.starting_usd)} start (marked, before exit costs)`} cls={tone(equity - a.starting_usd)} />
        <Stat label="Cash (paper USD)" value={tiny(a.cash_usd)} sub={`${v.open.length}/${a.config.maxOpenPositions} positions open · value ${tiny(marketValue)}`} />
        <Stat label="Realized P/L" value={tiny(realized)} sub={`${v.closed.length} closed (last 60 positions) · ${wins} winners`} cls={tone(realized)} />
        <Stat label="Total fees paid" value={tiny(a.fees_paid_usd)} sub="DEX fees + Solana tx fees (slippage is extra, inside fills)" />
      </div>
      <Panel title="Open positions" badge={a.paused ? <Badge tone="warn">Paused</Badge> : <Badge tone="ok">Running</Badge>}>
        <OpenTable rows={v.open} />
        <p className="mt-3 text-[11px] text-faint">
          Current = real DexScreener price at the last tick (every 15 minutes), not a live quote. P/L is marked to that price and does not include the cost of exiting. Last tick:{" "}
          {lastTick ? fmtUtc(lastTick.at) : "none yet"}.
        </p>
      </Panel>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Trade history">
          {v.trades.length === 0 ? (
            <p className="text-sm text-muted">No trades yet. The bot only buys tokens that pass every rug check, so none is normal.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse">
                <thead>
                  <tr>
                    <th className={th}>Time</th>
                    <th className={th}>Side</th>
                    <th className={th}>Token</th>
                    <th className={th}>Quote → fill</th>
                    <th className={th}>Value</th>
                    <th className={th}>Fees / slip</th>
                  </tr>
                </thead>
                <tbody>
                  {v.trades.map((t) => (
                    <tr key={t.id} className="border-t border-line/60">
                      <td className={td + " text-faint"}>{fmtUtc(t.executed_at)}</td>
                      <td className={td + (t.side === "buy" ? " text-ok" : " text-danger")}>{t.side}</td>
                      <td className={td}>
                        <TokenLink symbol={t.symbol} address={t.token_address} pair={t.pair_address} />
                        <div className="mt-1 max-w-[220px] text-[11px] text-faint">{t.reason}</div>
                      </td>
                      <td className={td + " font-mono"}>
                        {px(t.ref_price)} → {px(t.fill_price)}
                      </td>
                      <td className={td}>{tiny(t.notional_usd)}</td>
                      <td className={td}>
                        {tiny(t.dex_fee_usd + t.tx_fee_usd)}
                        <br />
                        <span className="text-[11px] text-faint">{(t.slippage_bps / 100).toFixed(2)}% slip</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {v.closed.length > 0 && (
            <div className="mt-4 border-t border-line/60 pt-3">
              <div className="mb-2 text-[11px] uppercase tracking-[0.12em] text-faint">Closed positions</div>
              <ul className="space-y-1">
                {v.closed.slice(0, 15).map((p) => (
                  <li key={p.id} className="text-xs text-muted">
                    <span className="text-ink">{p.symbol}</span> · {p.exit_reason} ·{" "}
                    <span className={tone(p.pnl_usd ?? 0)}>
                      {tiny(p.pnl_usd ?? 0)} ({pct(((p.proceeds_usd ?? 0) / p.cost_usd - 1) * 100)})
                    </span>{" "}
                    · {p.closed_at ? fmtUtc(p.closed_at) : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
        <Panel title="Recent rejections (rug checks)">
          {v.rejections.length === 0 ? (
            <p className="text-sm text-muted">No rejected candidates logged yet.</p>
          ) : (
            <ul className="max-h-[560px] space-y-3 overflow-y-auto pr-1">
              {v.rejections.map((c) => (
                <li key={c.id} className="text-xs">
                  <div className="flex items-baseline justify-between gap-3">
                    <TokenLink symbol={c.symbol} address={c.token_address} pair={c.pair_address} />
                    <span className="shrink-0 text-[11px] text-faint">{fmtUtc(c.seen_at)}</span>
                  </div>
                  <ul className="mt-1 list-disc pl-5 text-[11px] text-muted">
                    {c.reasons.map((r, i) => (
                      <li key={i}>
                        <span className="font-mono text-warn">{r.code}</span>: {r.detail}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Recent ticks">
          {v.ticks.length === 0 ? (
            <p className="text-sm text-muted">No ticks yet.</p>
          ) : (
            <ul className="space-y-2">
              {v.ticks.map((t) => (
                <li key={t.id} className="text-xs text-ink">
                  <span className="mr-2 text-faint">{fmtUtc(t.at)}</span>
                  {t.status === "applied" ? (
                    <>
                      <Badge tone="ok">applied</Badge>
                      <span className="ml-2 text-muted">
                        {t.candidates_seen} seen · {t.rejected} rejected · {t.bought} bought · {t.sold} sold · equity {t.equity_usd === null ? "n/a" : tiny(t.equity_usd)}
                      </span>
                    </>
                  ) : (
                    <>
                      <Badge tone="warn">skipped</Badge>
                      <span className="ml-2 text-muted">{t.skip_reason}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-faint">Failed or implausible data fetches skip the tick and appear here. Prices are never guessed.</p>
        </Panel>
        <Params c={{ ...DEFAULT_MEME_CONFIG, ...a.config }} />
      </div>
    </>
  );
}

export default async function Page() {
  const access = await requirePageAccess("/paper/meme");
  const header = (
    <PageHeader
      eyebrow="Simulation"
      title="Memecoin Paper Trading"
      subtitle="A $5 paper-money bot trading new trending Solana memecoins on real public prices, with rug checks, risk limits, fees and slippage modelled. Paper money only."
    />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  if (!supabaseConfigured()) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-dashed border-line-hi/70 bg-void/40 p-6 text-sm text-muted">
          <Badge tone="warn">Supabase not configured</Badge>
          <p className="mt-3">Set SUPABASE_URL and SUPABASE_SECRET_KEY to use memecoin paper trading.</p>
        </div>
      </>
    );
  }
  let view: MemeView;
  try {
    view = await loadMemeView();
  } catch {
    return (
      <>
        {header}
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-5 text-sm text-warn" role="alert">
          The memecoin paper-trading tables could not be queried. Check that the meme_paper_trading migration was applied and the Supabase key is valid.
        </div>
      </>
    );
  }
  const env = memeConfigFromEnv();
  return (
    <>
      {header}
      <div className="mb-3 text-xs text-muted">
        <Link className="text-electric-hi underline decoration-dotted underline-offset-2 hover:text-neon" href="/paper">
          ← BTC paper bot
        </Link>
      </div>
      <Banner />
      <Body v={view} />
      {!view.account && (
        <div className="mt-4">
          <Params c={env} />
        </div>
      )}
      <div className="mt-4">
        <MemeControls hasAccount={Boolean(view.account)} paused={Boolean(view.account?.paused)} startUsd={view.account?.config.startUsd ?? env.startUsd} />
      </div>
    </>
  );
}
