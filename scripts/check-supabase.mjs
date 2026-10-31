// TEMPORARY build-time check. Prints booleans/status only, never the key.
const k = process.env.SUPABASE_SECRET_KEY || "";
const u = process.env.SUPABASE_URL || "";
console.log("[check-supabase] key len>20:", k.length > 20, "sb_secret_:", k.startsWith("sb_secret_"), "len:", k.length, "url set:", Boolean(u));
if (k && u) {
  const r = await fetch(`${u}/rest/v1/workers?select=id&limit=1`, { headers: { apikey: k } });
  console.log("[check-supabase] REST status:", r.status);
}
