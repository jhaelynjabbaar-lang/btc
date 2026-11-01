import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/workers/guard";

export const dynamic = "force-dynamic";

/** GET /api/repair/ping — unauthenticated liveness + server time (lets the PC compare its clock). Returns nothing sensitive. */
export function GET() {
  return NextResponse.json({ ok: true, time: new Date().toISOString() }, { headers: NO_STORE });
}
