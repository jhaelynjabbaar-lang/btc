import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cloudflare Worker has its own package/tsconfig; ignore generated + built files.
    "cloudflare/**/dist/**",
    "cloudflare/**/worker-configuration.d.ts",
    "cloudflare/**/.wrangler/**",
    // Rust worker agent (own toolchain); only a vector-generator script is JS/TS.
    "agent/**",
  ]),
]);

export default eslintConfig;
