import type { MemeConfig } from "./config";
import { round6 } from "./costs";

/**
 * Transparent momentum strategy with hard risk limits.
 *   ENTRY  a token that passes every rug check (filters.ts) AND shows momentum (1h up, 6h not down, buyers outnumber sellers).
 *          Candidates are ranked by 1h price change, strongest first, and bought while a slot and cash are free.
 *   SIZE   positionPct (30%) of current equity per position, at most maxOpenPositions (3) open at once.
 *   EXIT   first rule that fires, checked every tick on the real mark:
 *            1. pair vanished from the data for N ticks in a row  -> written off at $0 (assume rugged)
 *            2. liquidity collapsed vs entry                      -> sell now
 *            3. stop-loss      mark <= entry x (1 - stopLossPct)
 *            4. trailing stop  after the peak was +trailActivatePct over entry, sell if mark <= peak x (1 - trailPct)
 *            5. take-profit    mark >= entry x (1 + takeProfitPct)
 *            6. max hold       open for longer than maxHoldHours
 * Ticks are 15 minutes apart, so a stop can only fire on a tick: the fill is at that tick's real mark, which may be well below the stop level.
 */

export type OpenPosition = {
  id: string;
  tokenAddress: string;
  entryFillPrice: number;
  peakPrice: number;
  openedAtMs: number;
  entryLiquidityUsd: number;
  missingTicks: number;
};

export type Mark = { price: number; liquidityUsd: number | null };

export type ExitDecision = { exit: false } | { exit: true; reason: ExitReason; writeOff: boolean; detail: string };
export type ExitReason = "written_off_pair_gone" | "liquidity_collapse" | "stop_loss" | "trailing_stop" | "take_profit" | "max_hold";

/** `mark === null` means the pair was absent from a successful response. The caller increments `missingTicks` before calling. */
export function exitDecision(pos: OpenPosition, mark: Mark | null, nowMs: number, cfg: MemeConfig): ExitDecision {
  if (mark === null) {
    if (pos.missingTicks >= cfg.writeOffAfterMissingTicks)
      return { exit: true, reason: "written_off_pair_gone", writeOff: true, detail: `no usable pool in ${pos.missingTicks} consecutive ticks; written off at $0` };
    return { exit: false };
  }
  const peak = Math.max(pos.peakPrice, mark.price);
  if (mark.liquidityUsd === null || mark.liquidityUsd < pos.entryLiquidityUsd * (1 - cfg.liquidityCollapsePct / 100))
    return {
      exit: true,
      reason: "liquidity_collapse",
      writeOff: false,
      detail: `liquidity ${mark.liquidityUsd === null ? "n/a" : "$" + Math.round(mark.liquidityUsd)} fell more than ${cfg.liquidityCollapsePct}% below entry $${Math.round(pos.entryLiquidityUsd)}`,
    };
  const pnl = (mark.price / pos.entryFillPrice - 1) * 100;
  if (mark.price <= pos.entryFillPrice * (1 - cfg.stopLossPct / 100)) return { exit: true, reason: "stop_loss", writeOff: false, detail: `mark ${pnl.toFixed(1)}% vs entry fill <= -${cfg.stopLossPct}%` };
  if (peak >= pos.entryFillPrice * (1 + cfg.trailActivatePct / 100) && mark.price <= peak * (1 - cfg.trailPct / 100))
    return { exit: true, reason: "trailing_stop", writeOff: false, detail: `mark ${((mark.price / peak - 1) * 100).toFixed(1)}% below the peak (+${((peak / pos.entryFillPrice - 1) * 100).toFixed(1)}% over entry)` };
  if (mark.price >= pos.entryFillPrice * (1 + cfg.takeProfitPct / 100)) return { exit: true, reason: "take_profit", writeOff: false, detail: `mark +${pnl.toFixed(1)}% vs entry fill >= +${cfg.takeProfitPct}%` };
  const heldH = (nowMs - pos.openedAtMs) / 3_600_000;
  if (heldH >= cfg.maxHoldHours) return { exit: true, reason: "max_hold", writeOff: false, detail: `held ${heldH.toFixed(1)}h >= ${cfg.maxHoldHours}h` };
  return { exit: false };
}

/** USD to spend on the next position, or null when there is no slot or the amount is below the minimum. Never more than the cash on hand. */
export function sizePosition(cashUsd: number, equityUsd: number, openCount: number, cfg: MemeConfig): number | null {
  if (openCount >= cfg.maxOpenPositions) return null;
  const size = round6(Math.min(cashUsd, equityUsd * cfg.positionPct));
  return size >= cfg.minPositionUsd ? size : null;
}
