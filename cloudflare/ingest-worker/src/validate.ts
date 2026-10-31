import { UUID_RE, isValidPublicKey, normalizeEnrollCode } from "./protocol";

export const MAX_ENROLL_BODY = 4_096;
export const MAX_TELEMETRY_BODY = 32_768;
export const MAX_ACK_BODY = 2_048;
export const MAX_BATCH_ROWS = 120; // two hours of 1-minute rollups
export const MAX_ACK_IDS = 50;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // buckets older than a week are rejected
const MAX_FUTURE_MS = 5 * 60 * 1000;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasOnly = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function str(v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < min || t.length > max || CONTROL_RE.test(t)) return null;
  return t;
}
function int(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : null;
}
function num(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

// ------------------------------------------------------------------ enroll
export const HARDWARE_TYPES = ["cpu", "gpu", "asic", "cloud", "other"] as const;
export type HardwareType = (typeof HARDWARE_TYPES)[number];

export type EnrollRequest = {
  code: string; // normalized
  public_key: string;
  name: string | null;
  hardware_type: HardwareType;
  os: string | null;
  software_version: string | null;
  hardware: Record<string, string | number>;
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,62}$/;

export function parseEnroll(body: unknown): Result<EnrollRequest> {
  if (!isObj(body) || !hasOnly(body, ["code", "public_key", "name", "hardware"])) return fail("invalid_request");
  if (typeof body.code !== "string") return fail("invalid_request");
  const code = normalizeEnrollCode(body.code);
  if (!code) return fail("invalid_request");
  if (typeof body.public_key !== "string" || !isValidPublicKey(body.public_key)) return fail("invalid_request");

  let name: string | null = null;
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !NAME_RE.test(body.name.trim())) return fail("invalid_request");
    name = body.name.trim();
  }

  const hw = body.hardware;
  if (!isObj(hw) || !hasOnly(hw, ["hardware_type", "os", "arch", "cpu_model", "cpu_cores", "memory_mb", "gpu", "software_version"])) return fail("invalid_request");
  const hardware_type = hw.hardware_type;
  if (typeof hardware_type !== "string" || !(HARDWARE_TYPES as readonly string[]).includes(hardware_type)) return fail("invalid_request");

  const clean: Record<string, string | number> = {};
  for (const [k, max] of [["os", 64], ["arch", 32], ["cpu_model", 128], ["gpu", 128], ["software_version", 32]] as const) {
    if (hw[k] === undefined) continue;
    const s = str(hw[k], 1, max);
    if (s === null) return fail("invalid_request");
    clean[k] = s;
  }
  for (const [k, max] of [["cpu_cores", 4096], ["memory_mb", 16_777_216]] as const) {
    if (hw[k] === undefined) continue;
    const n = int(hw[k], 1, max);
    if (n === null) return fail("invalid_request");
    clean[k] = n;
  }
  return {
    ok: true,
    value: {
      code,
      public_key: body.public_key,
      name,
      hardware_type: hardware_type as HardwareType,
      os: typeof clean.os === "string" ? clean.os : null,
      software_version: typeof clean.software_version === "string" ? clean.software_version : null,
      hardware: clean,
    },
  };
}

// --------------------------------------------------------------- telemetry
export type TelemetryRow = {
  bucket_start: string; // ISO, minute-aligned, UTC
  avg_hashrate_hs: number;
  accepted: number;
  rejected: number;
  difficulty: number | null;
  temperature_c: number | null;
};
export type TelemetryBatch = { rows: TelemetryRow[]; uptime_s: number | null; software_version: string | null };

const ROW_KEYS = ["bucket_start", "avg_hashrate_hs", "accepted", "rejected", "difficulty", "temperature_c"] as const;
const BUCKET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/;

export function parseTelemetry(body: unknown, nowMs: number): Result<TelemetryBatch> {
  if (!isObj(body) || !hasOnly(body, ["rows", "uptime_s", "software_version"])) return fail("invalid_request");
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_BATCH_ROWS) return fail("invalid_request");

  const seen = new Set<number>();
  const out: TelemetryRow[] = [];
  for (const r of rows) {
    if (!isObj(r) || !hasOnly(r, ROW_KEYS)) return fail("invalid_request");
    if (typeof r.bucket_start !== "string" || !BUCKET_RE.test(r.bucket_start)) return fail("invalid_request");
    const t = Date.parse(r.bucket_start);
    if (!Number.isFinite(t) || t < nowMs - MAX_AGE_MS || t > nowMs + MAX_FUTURE_MS) return fail("invalid_request");
    if (seen.has(t)) return fail("invalid_request"); // duplicate bucket in one batch
    seen.add(t);
    const avg = num(r.avg_hashrate_hs, 0, 1e21);
    const accepted = int(r.accepted, 0, Number.MAX_SAFE_INTEGER);
    const rejected = int(r.rejected, 0, Number.MAX_SAFE_INTEGER);
    if (avg === null || accepted === null || rejected === null) return fail("invalid_request");
    let difficulty: number | null = null;
    if (r.difficulty !== undefined && r.difficulty !== null) {
      difficulty = num(r.difficulty, 0, 1e21);
      if (difficulty === null) return fail("invalid_request");
    }
    let temperature: number | null = null;
    if (r.temperature_c !== undefined && r.temperature_c !== null) {
      temperature = num(r.temperature_c, -50, 250);
      if (temperature === null) return fail("invalid_request");
    }
    out.push({
      bucket_start: new Date(t).toISOString(),
      avg_hashrate_hs: avg,
      accepted,
      rejected,
      difficulty,
      temperature_c: temperature,
    });
  }

  let uptime_s: number | null = null;
  if (body.uptime_s !== undefined) {
    uptime_s = int(body.uptime_s, 0, 10 * 365 * 24 * 3600);
    if (uptime_s === null) return fail("invalid_request");
  }
  let software_version: string | null = null;
  if (body.software_version !== undefined) {
    software_version = str(body.software_version, 1, 32);
    if (software_version === null) return fail("invalid_request");
  }
  return { ok: true, value: { rows: out, uptime_s, software_version } };
}

// --------------------------------------------------------------------- ack
export function parseAck(body: unknown): Result<{ ids: string[] }> {
  if (!isObj(body) || !hasOnly(body, ["ids"])) return fail("invalid_request");
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ACK_IDS) return fail("invalid_request");
  const set = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !UUID_RE.test(id)) return fail("invalid_request");
    set.add(id);
  }
  return { ok: true, value: { ids: [...set] } };
}
