import { DurableObject } from "cloudflare:workers";

/**
 * One instance per worker id (addressed by name). Stores recently seen request nonces so a captured, correctly
 * signed request cannot be replayed inside its validity window. SQLite-backed (Workers Free plan compatible).
 * Entries are tiny and deleted lazily once expired.
 */
export class NonceStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID");
  }

  /** Returns true the first time a nonce is seen, false if it was already claimed (replay). */
  claim(nonce: string, ttlSeconds: number): boolean {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("DELETE FROM nonces WHERE expires_at <= ?", now);
    const cur = sql.exec("INSERT OR IGNORE INTO nonces (nonce, expires_at) VALUES (?, ?)", nonce, now + ttlSeconds * 1000);
    return cur.rowsWritten > 0;
  }
}
