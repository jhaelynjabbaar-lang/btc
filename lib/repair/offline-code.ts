import { FINDING_STATUSES, OFFLINE_COUNT, OFFLINE_ORDER, type FindingId, type FindingStatus } from "./actions";

/**
 * Offline code: the Windows 7 script prints a short code that summarizes its first OFFLINE_COUNT findings (2 bits each) so the admin
 * can type it into /repair from a phone when the PC cannot reach the server. Format: W7-XXXX-XXXX-XXXX-C
 *   X = 12 hex digits (24 findings x 2 bits: 0 unknown, 1 ok, 2 warn, 3 fail, in OFFLINE_ORDER)
 *   C = check digit: sum(hexdigit[i] * (i + 1)) mod 16.
 * The same algorithm is implemented in agent/win7-repair/repair.bat (a test vector in both places keeps them identical).
 */

const HEX = "0123456789ABCDEF";

function checkDigit(hex12: string): string {
  let sum = 0;
  for (let i = 0; i < hex12.length; i++) sum += HEX.indexOf(hex12[i]) * (i + 1);
  return HEX[sum % 16];
}

export function encodeOfflineCode(statuses: Partial<Record<FindingId, FindingStatus>>): string {
  let hex = "";
  for (let j = 0; j < OFFLINE_COUNT / 2; j++) {
    const a = FINDING_STATUSES.indexOf(statuses[OFFLINE_ORDER[2 * j]] ?? "unknown");
    const b = FINDING_STATUSES.indexOf(statuses[OFFLINE_ORDER[2 * j + 1]] ?? "unknown");
    hex += HEX[(a << 2) | b];
  }
  return `W7-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${checkDigit(hex)}`;
}

export type DecodeResult = { ok: true; statuses: Record<FindingId, FindingStatus>; code: string } | { ok: false; reason: "format" | "checksum" };

export function decodeOfflineCode(input: string): DecodeResult {
  if (typeof input !== "string" || input.length > 40) return { ok: false, reason: "format" };
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0");
  const m = /^W7([0-9A-F]{12})([0-9A-F])$/.exec(s);
  if (!m) return { ok: false, reason: "format" };
  const hex = m[1];
  if (checkDigit(hex) !== m[2]) return { ok: false, reason: "checksum" };
  const statuses = {} as Record<FindingId, FindingStatus>;
  for (let j = 0; j < OFFLINE_COUNT / 2; j++) {
    const v = HEX.indexOf(hex[j]);
    statuses[OFFLINE_ORDER[2 * j]] = FINDING_STATUSES[(v >> 2) & 3];
    statuses[OFFLINE_ORDER[2 * j + 1]] = FINDING_STATUSES[v & 3];
  }
  return { ok: true, statuses, code: `W7-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${m[2]}` };
}
