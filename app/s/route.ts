import { loadSpeedupScript } from "@/lib/speedup/script";

export const dynamic = "force-dynamic";

/**
 * GET /s — serves the Windows 7 speed-up script (public: it contains no secrets, makes no network calls and cannot change
 * anything without a local Y/N). Open it in Firefox ESR 115 on the PC (Windows 7's own TLS cannot reach *.vercel.app) or copy
 * the file by USB. See docs/win7-speedup.md.
 */
export function GET() {
  const { text, sha256 } = loadSpeedupScript();
  return new Response(text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="speedup.bat"',
      "cache-control": "no-store",
      "x-content-sha256": sha256,
      "x-content-type-options": "nosniff",
    },
  });
}
