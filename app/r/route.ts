import { loadScript } from "@/lib/repair/script";

export const dynamic = "force-dynamic";

/**
 * GET /r — serves the Windows 7 repair script (public: it contains no secrets and cannot do anything without a local Y/N).
 * NOTE: Windows 7's built-in TLS cannot negotiate with Vercel (see docs/win7-repair.md); this URL is for a modern browser,
 * a relay that Windows 7 can reach, or copying the file by USB. It still works fine from a phone/Chromebook.
 */
export function GET() {
  const { text, sha256 } = loadScript();
  return new Response(text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="repair.bat"',
      "cache-control": "no-store",
      "x-content-sha256": sha256,
      "x-content-type-options": "nosniff",
    },
  });
}
