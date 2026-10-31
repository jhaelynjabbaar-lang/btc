/**
 * Lightweight deterministic pre-scan. Pure string/regex matching over the submitted text:
 * submitted code is NEVER executed, evaluated, imported or built.
 */
export type RuleSeverity = "critical" | "high" | "medium" | "low" | "info";

export type RuleFinding = {
  ruleId: string;
  severity: RuleSeverity;
  title: string;
  line: number;
  /** The matching line, trimmed and with any secret-looking value masked. */
  snippet: string;
  advice: string;
};

type Rule = {
  id: string;
  severity: RuleSeverity;
  title: string;
  re: RegExp;
  advice: string;
  /** Only report when the same line also matches this (context filter). */
  also?: RegExp;
};

const KEYISH = /(priv(ate)?[_-]?key|secret|seed|mnemonic|nonce|wallet|entropy|token|passw|\bkey\b|\bk\b\s*=)/i;

export const RULES: Rule[] = [
  { id: "js-eval", severity: "high", title: "Dynamic code evaluation (eval / new Function)", re: /\b(eval\s*\(|new\s+Function\s*\()/, advice: "Avoid evaluating strings as code; parse data (JSON.parse) or use explicit dispatch tables." },
  { id: "py-eval-exec", severity: "high", title: "Dynamic code evaluation (eval / exec)", re: /(^|[^\w.])(eval|exec)\s*\(/, advice: "Do not eval/exec untrusted strings; use ast.literal_eval or explicit parsing." },
  { id: "cmd-exec", severity: "high", title: "OS command execution", re: /\b(child_process|execSync|spawnSync|os\.system|os\.popen|subprocess\.(run|call|Popen|check_output)|Runtime\.getRuntime\(\)\.exec|shell_exec|system\s*\()/, advice: "Avoid shelling out; if unavoidable use argument arrays without a shell and strictly validated input." },
  { id: "py-shell-true", severity: "high", title: "subprocess with shell=True", re: /shell\s*=\s*True/, advice: "Pass an argument list and leave shell=False." },
  { id: "deserialize", severity: "high", title: "Unsafe deserialization", re: /\b(pickle\.loads?|marshal\.loads?|yaml\.load\s*\((?![^)]*Loader\s*=\s*(yaml\.)?SafeLoader)|unserialize\s*\()/, advice: "Never deserialize untrusted data with pickle/marshal/yaml.load; use JSON or yaml.safe_load." },
  { id: "weak-rng-keys", severity: "high", title: "Non-cryptographic RNG used near key/seed/nonce material", re: /(Math\.random\s*\(|\brandom\.(random|randint|randrange|choice|getrandbits|seed)\s*\(|\brand\s*\(|\bmt_rand\s*\()/, also: KEYISH, advice: "Use a CSPRNG (crypto.randomBytes / crypto.getRandomValues / secrets / os.urandom) for keys, seeds and nonces. Predictable ECDSA nonces leak private keys." },
  { id: "weak-rng", severity: "low", title: "Non-cryptographic RNG", re: /(Math\.random\s*\(|\brandom\.(random|randint|randrange|choice)\s*\()/, advice: "Fine for non-security uses; never for secrets, tokens or key material." },
  { id: "hardcoded-nonce", severity: "high", title: "Hard-coded or reused ECDSA nonce / k value", re: /\b(nonce|k)\s*[:=]\s*(0x[0-9a-fA-F]+|\d+)\b/, also: /(ecdsa|sign|secp256k1|signature|nonce)/i, advice: "Derive k with RFC 6979 or use a library that does; reusing/predicting k reveals the private key." },
  { id: "weak-hash", severity: "medium", title: "Weak hash function (MD5 / SHA-1)", re: /(createHash\(\s*['"](md5|sha1)['"]|hashlib\.(md5|sha1)\b|MessageDigest\.getInstance\(\s*"(MD5|SHA-?1)")/i, advice: "Use SHA-256 or stronger (Bitcoin uses double SHA-256 / tagged hashes); never MD5/SHA-1 for security." },
  { id: "tls-verify-off", severity: "high", title: "TLS certificate verification disabled", re: /(rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(0|false))/, advice: "Keep certificate verification on; pin or fix the CA instead." },
  { id: "plain-http", severity: "low", title: "Plain http:// URL", re: /['"]http:\/\/(?!localhost|127\.0\.0\.1)/, advice: "Use https:// for anything carrying credentials or transaction data." },
  { id: "dom-xss", severity: "medium", title: "Potential DOM XSS sink", re: /(\.innerHTML\s*=|dangerouslySetInnerHTML|document\.write\s*\()/, advice: "Use textContent or sanitize with a vetted library." },
  { id: "sql-concat", severity: "medium", title: "SQL built by string concatenation / formatting", re: /(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(\+\s*\w+|%s|\$\{[^}]+\}|\.format\()/i, also: /(query|execute|exec|cursor|sql)/i, advice: "Use parameterized queries / prepared statements." },
  { id: "float-amount", severity: "medium", title: "Floating-point arithmetic on a coin amount", re: /(parseFloat|float\s*\(|Number\s*\()[^\n]*\b(btc|amount|satoshi|sats|balance|fee)/i, advice: "Represent amounts as integer satoshis (BigInt / int) to avoid rounding errors." },
  { id: "sighash", severity: "medium", title: "Non-default SIGHASH flag", re: /SIGHASH_(NONE|ANYONECANPAY|SINGLE)/, advice: "Ensure partial-signature flags are intentional; SIGHASH_NONE lets others change outputs after signing." },
  { id: "timing-compare", severity: "medium", title: "Non-constant-time comparison of secret/MAC/signature", re: /\b(hmac|signature|sig|mac|digest|token)\w*\s*(===?|!==?)\s*\w+/i, advice: "Compare secrets with crypto.timingSafeEqual / hmac.compare_digest." },
  { id: "debug-secret-log", severity: "medium", title: "Possible logging of secret material", re: /(console\.(log|debug|info)|print\s*\(|logger?\.\w+\s*\()[^\n]*(priv(ate)?[_-]?key|seed|mnemonic|secret|passw)/i, advice: "Never log keys, seeds or passwords." },
];

/** Secret-shaped values. Matches are masked before display AND before any text is sent to the model. */
const SECRET_PATTERNS: Array<{ id: string; severity: RuleSeverity; title: string; re: RegExp; advice: string }> = [
  { id: "secret-private-key-block", severity: "critical", title: "PEM private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/, advice: "Remove the key from source, rotate it, load it from a secret store." },
  { id: "secret-wif", severity: "critical", title: "Bitcoin WIF private key", re: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/, advice: "Treat the key as compromised: move funds, rotate, never commit private keys." },
  { id: "secret-xprv", severity: "critical", title: "BIP32 extended private key (xprv)", re: /\b[xyztu]prv[1-9A-HJ-NP-Za-km-z]{100,112}\b/, advice: "Treat as compromised; never commit extended private keys." },
  { id: "secret-hex-key", severity: "high", title: "64-hex-character value assigned to a key/secret variable", re: /(priv(ate)?[_-]?key|secret|seed)\w*\s*[:=]\s*['"]?(0x)?[0-9a-fA-F]{64}\b/i, advice: "Hard-coded 256-bit secret; load from a secret store and rotate." },
  { id: "secret-aws", severity: "critical", title: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/, advice: "Revoke and rotate the key; use IAM roles/secret manager." },
  { id: "secret-token", severity: "high", title: "API token (sk-/ghp_/xox…)", re: /\b(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/, advice: "Revoke and rotate; load from environment/secret store." },
  { id: "secret-assigned", severity: "high", title: "Hard-coded credential", re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\w*\s*[:=]\s*['"][^'"\s]{8,}['"]/i, advice: "Move credentials to environment variables or a secret manager and rotate them." },
];

const MASK = "[REDACTED_SECRET]";
const MAX_LINE = 2000;

/** Mask every secret-shaped value in a line. Used before display and before sending to a model. */
export function maskSecrets(line: string): string {
  let out = line;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g"), (m) => {
      // keep the variable name for assigned secrets, mask only the value
      const assign = m.match(/^([^:=]+[:=]\s*)(['"]?)(.+?)(['"]?)$/);
      return assign && /[:=]/.test(m) && p.id !== "secret-private-key-block" ? `${assign[1]}${assign[2]}${MASK}${assign[4]}` : MASK;
    });
  }
  return out;
}

export function maskCode(code: string): { masked: string; maskedCount: number } {
  let count = 0;
  const masked = code
    .split("\n")
    .map((l) => {
      const m = maskSecrets(l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l);
      if (m !== l) count++;
      return m;
    })
    .join("\n");
  return { masked, maskedCount: count };
}

export function prescan(code: string): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length && findings.length < 200; i++) {
    const raw = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) : lines[i];
    const snippet = maskSecrets(raw).trim().slice(0, 200);
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(raw)) {
        findings.push({ ruleId: p.id, severity: p.severity, title: p.title, line: i + 1, snippet, advice: p.advice });
      }
    }
    for (const r of RULES) {
      if (r.re.test(raw) && (!r.also || r.also.test(raw))) {
        // the specific weak-rng-keys rule supersedes the generic weak-rng on the same line
        if (r.id === "weak-rng" && findings.some((f) => f.line === i + 1 && f.ruleId === "weak-rng-keys")) continue;
        findings.push({ ruleId: r.id, severity: r.severity, title: r.title, line: i + 1, snippet, advice: r.advice });
      }
    }
  }
  return findings;
}
