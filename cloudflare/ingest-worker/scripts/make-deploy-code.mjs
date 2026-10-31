// Builds the JavaScript body for the Cloudflare MCP `execute` tool that uploads the bundled Worker
// (used because the box has no Wrangler credentials). Mirrors wrangler.toml. Writes to the path given as argv[2].
// Usage: npm run build && node scripts/make-deploy-code.mjs /tmp/deploy.txt [--redeploy] [--with-secret]
// With --with-secret the SUPABASE_SECRET_KEY value is read from the environment and embedded in the output FILE only
// (never printed). Otherwise the existing secret binding is kept (keep_bindings).
import { readFileSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) throw new Error("output path required");
const withSecret = process.argv.includes("--with-secret");
const redeploy = process.argv.includes("--redeploy"); // migration v1 already applied: omit it
const bundle = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");

const bindings = [
  { type: "plain_text", name: "SUPABASE_URL", text: "https://kcfeajaycufkskxjyxxb.supabase.co" },
  { type: "durable_object_namespace", name: "NONCE_STORE", class_name: "NonceStore" },
  { type: "ratelimit", name: "RL_IP", namespace_id: "7101", simple: { limit: 120, period: 60 } },
  { type: "ratelimit", name: "RL_ENROLL", namespace_id: "7102", simple: { limit: 6, period: 60 } },
  { type: "ratelimit", name: "RL_WORKER", namespace_id: "7103", simple: { limit: 40, period: 60 } },
];
if (withSecret) {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY not set");
  bindings.push({ type: "secret_text", name: "SUPABASE_SECRET_KEY", text: key });
}
const metadata = {
  main_module: "index.js",
  compatibility_date: "2026-10-31",
  bindings,
  observability: { enabled: true, traces: { enabled: true } },
  ...(redeploy ? {} : { migrations: { new_tag: "v1", new_sqlite_classes: ["NonceStore"] } }),
  ...(withSecret ? {} : { keep_bindings: ["secret_text"] }),
};
const code = `async () => {
  const name = "btc-network-ingest";
  const metadata = ${JSON.stringify(metadata)};
  const source = ${JSON.stringify(bundle)};
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
  const up = await cloudflare.request({ method: "PUT", path: \`/accounts/\${accountId}/workers/scripts/\${name}\`, body: form });
  const sub = await cloudflare.request({ method: "POST", path: \`/accounts/\${accountId}/workers/scripts/\${name}/subdomain\`, body: { enabled: true, previews_enabled: false } });
  return { uploaded: up.success, errors: up.errors, subdomain: sub.result };
}
`;
writeFileSync(out, code, { mode: 0o600 });
console.log(`wrote ${out} (${code.length} bytes, secret ${withSecret ? "embedded" : "not included"})`);
