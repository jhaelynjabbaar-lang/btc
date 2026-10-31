import { UUID_RE } from "./protocol";

/** Minimal PostgREST client (service key, server-to-server). Never logs or returns the key or response bodies. */
export class DbError extends Error {
  constructor(readonly status: number) {
    super(`supabase_error_${status}`);
  }
}

export type WorkerAuth = { id: string; status: string; keys: string[] };

export type Db = {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
  getWorkerAuth(workerId: string): Promise<WorkerAuth | null>;
  ping(): Promise<boolean>;
};

type DbEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

export function createDb(env: DbEnv, fetcher: typeof fetch = fetch): Db {
  const base = env.SUPABASE_URL.replace(/\/+$/, "");
  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    apikey: env.SUPABASE_SECRET_KEY,
    authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    "content-type": "application/json",
    ...extra,
  });
  const signal = () => AbortSignal.timeout(8_000);

  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      if (!/^[a-z_]+$/.test(fn)) throw new DbError(0);
      const res = await fetcher(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers: headers(), body: JSON.stringify(args), signal: signal() });
      if (!res.ok) throw new DbError(res.status);
      return (await res.json()) as T;
    },

    async getWorkerAuth(workerId: string): Promise<WorkerAuth | null> {
      if (!UUID_RE.test(workerId)) return null;
      const url = `${base}/rest/v1/workers?id=eq.${workerId}&select=id,status,worker_credentials(public_key,revoked_at)&limit=1`;
      const res = await fetcher(url, { method: "GET", headers: headers({ accept: "application/json" }), signal: signal() });
      if (!res.ok) throw new DbError(res.status);
      const rows = (await res.json()) as Array<{ id: string; status: string; worker_credentials: Array<{ public_key: string | null; revoked_at: string | null }> }>;
      const w = rows[0];
      if (!w) return null;
      const keys = (w.worker_credentials ?? []).filter((c) => c.public_key && !c.revoked_at).map((c) => c.public_key as string);
      return { id: w.id, status: w.status, keys };
    },

    async ping(): Promise<boolean> {
      try {
        const res = await fetcher(`${base}/rest/v1/workers?select=id&limit=1`, { method: "GET", headers: headers({ accept: "application/json" }), signal: AbortSignal.timeout(3_000) });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
