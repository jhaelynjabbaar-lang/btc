import "server-only";
import { getSupabaseServer } from "@/lib/supabase/server";
import { ENROLL_CODE_TTL_MS, MAX_ACTIVE_CODES, generateEnrollCode, hashEnrollCode, normalizeEnrollCode } from "./enrollment";
import type { WorkerCommand } from "./config";

export type MintResult =
  | { ok: true; code: string; expiresAt: string }
  | { ok: false; reason: "too_many_active" | "failed" };

/** Create a one-time enrollment code. Stores only its hash; writes an audit entry without the code. */
export async function mintEnrollmentCode(ownerId: string, actor: string): Promise<MintResult> {
  const db = getSupabaseServer();
  const nowIso = new Date().toISOString();
  const active = await db
    .from("worker_enrollment_codes")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId)
    .is("used_at", null)
    .gt("expires_at", nowIso);
  if (active.error) return { ok: false, reason: "failed" };
  if ((active.count ?? 0) >= MAX_ACTIVE_CODES) return { ok: false, reason: "too_many_active" };

  const code = generateEnrollCode();
  const hash = hashEnrollCode(normalizeEnrollCode(code)!);
  const expiresAt = new Date(Date.now() + ENROLL_CODE_TTL_MS).toISOString();
  const ins = await db.from("worker_enrollment_codes").insert({ owner_id: ownerId, code_hash: hash, expires_at: expiresAt }).select("id").single();
  if (ins.error || !ins.data) return { ok: false, reason: "failed" };
  await db.from("audit_log").insert({
    actor,
    action: "enrollment_code.minted",
    entity_type: "enrollment_code",
    entity_id: ins.data.id,
    details: { owner_id: ownerId, expires_at: expiresAt },
  });
  return { ok: true, code, expiresAt };
}

export type QueueResult = { ok: true; id: string; expiresAt: string } | { ok: false; reason: "not_found" | "revoked" | "duplicate" | "failed" };

/** Queue a start/pause/stop command for a worker (delivered on the worker's next signed poll). */
export async function queueWorkerCommand(workerId: string, command: WorkerCommand, actor: string): Promise<QueueResult> {
  const db = getSupabaseServer();
  const w = await db.from("workers").select("id, owner_id, status").eq("id", workerId).maybeSingle();
  if (w.error) return { ok: false, reason: "failed" };
  if (!w.data) return { ok: false, reason: "not_found" };
  if (w.data.status === "revoked") return { ok: false, reason: "revoked" };

  const dup = await db
    .from("worker_commands")
    .select("id", { count: "exact", head: true })
    .eq("worker_id", workerId)
    .eq("command", command)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString());
  if (dup.error) return { ok: false, reason: "failed" };
  if ((dup.count ?? 0) > 0) return { ok: false, reason: "duplicate" };

  const ins = await db
    .from("worker_commands")
    .insert({ worker_id: workerId, owner_id: w.data.owner_id, command, created_by: actor })
    .select("id, expires_at")
    .single();
  if (ins.error || !ins.data) return { ok: false, reason: "failed" };
  await db.from("audit_log").insert({
    actor,
    action: "worker_command.queued",
    entity_type: "worker",
    entity_id: workerId,
    details: { command, command_id: ins.data.id },
  });
  return { ok: true, id: ins.data.id, expiresAt: ins.data.expires_at };
}
