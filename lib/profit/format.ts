/**
 * Number formatting for money. The one rule: a value that is not exactly zero is NEVER displayed as zero.
 * Tiny amounts (a CPU earns a fraction of a satoshi a day) keep their significant digits instead of being rounded away.
 */

/** Plain-decimal string for a small positive number (no exponent), keeping `sig` significant digits. */
function plainSmall(abs: number, sig: number): string {
  if (abs < 1e-12) return abs.toExponential(sig - 1);
  const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(abs)));
  return abs.toFixed(Math.min(20, digits));
}

/** Number with thousands separators for >= 1, and significant digits below 1. */
export function fmtNum(n: number, sig = 3): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1000) return sign + abs.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return sign + Number(abs.toFixed(2)).toString();
  return sign + plainSmall(abs, sig);
}

export const fmtSats = (n: number): string => `${fmtNum(n)} sats`;

/** BTC from sats, always shown with the full 8 decimals for >= 1 sat, and the exact small value below that. */
export function fmtBtcFromSats(sats: number): string {
  if (!Number.isFinite(sats)) return "—";
  if (sats === 0) return "0 BTC";
  if (Math.abs(sats) >= 1) return `${(sats / 1e8).toFixed(8)} BTC`;
  return `${fmtNum(sats / 1e8)} BTC`;
}

/** USD with a sign in front of the dollar sign. Amounts under one cent keep their significant digits. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs === 0) return "$0.00";
  if (abs >= 0.01) return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${sign}$${plainSmall(abs, 3)}`;
}

export function fmtHashrate(hs: number): string {
  if (!Number.isFinite(hs)) return "—";
  if (hs <= 0) return "0 H/s";
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s", "ZH/s"];
  let v = hs;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

/** "unavailable" for null, so a missing value is never rendered as a number. */
export const orUnavailable = (n: number | null, f: (x: number) => string): string => (n === null ? "unavailable" : f(n));
