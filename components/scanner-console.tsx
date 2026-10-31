"use client";

import { useMemo, useRef, useState } from "react";
import { runScanRequest } from "@/lib/client/api";
import type { ScanResult } from "@/lib/ai/scan";
import { ALLOWED_EXTENSIONS, MAX_CODE_BYTES } from "@/lib/scan/limits";
import { Badge, SeverityBadge } from "./ui";

const SAMPLE = `// sample.js — deliberately insecure, for demo only
const crypto = require("crypto");
const { exec } = require("child_process");

const WALLET_SECRET = "5JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ";

function newPrivateKey() {
  // predictable: Math.random is not a CSPRNG
  let k = "";
  for (let i = 0; i < 32; i++) k += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return k;
}

function checkSignature(signature, expected) {
  return signature == expected;
}

function runUserCommand(cmd) {
  exec("bitcoin-cli " + cmd);
}

function toSats(btc) {
  return parseFloat(btc) * 1e8;
}

console.log("private key:", newPrivateKey());
`;

function download(name: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ScannerConsole() {
  const [code, setCode] = useState("");
  const [filename, setFilename] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scanned, setScanned] = useState<{ code: string; filename: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const bytes = useMemo(() => new TextEncoder().encode(code).length, [code]);
  const tooBig = bytes > MAX_CODE_BYTES;
  const canScan = authorized && code.trim().length > 0 && !tooBig && !busy;

  async function onFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    const ext = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      setError(`Unsupported file type "${ext || "none"}". Allowed: ${ALLOWED_EXTENSIONS.join(" ")}`);
      return;
    }
    if (file.size > MAX_CODE_BYTES) {
      setError(`File is ${(file.size / 1024).toFixed(0)} KB; the limit is ${MAX_CODE_BYTES / 1024} KB.`);
      return;
    }
    const text = await file.text(); // read as text in the browser; never executed
    if (text.includes("\u0000")) {
      setError("That file looks binary; only text source files are supported.");
      return;
    }
    setCode(text);
    setFilename(file.name);
  }

  async function scan() {
    if (!canScan) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await runScanRequest({ code, filename: filename || undefined, authorized: true }, ac.signal);
      setResult(r);
      setScanned({ code, filename });
    } catch (e) {
      setError(e instanceof DOMException && e.name === "AbortError" ? "Cancelled." : e instanceof Error ? e.message : "Scan failed.");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const lines = scanned?.code.split("\n") ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-panel/70 px-4 py-2.5 text-xs text-muted">
        Static analysis only: submitted code is treated as text and is <strong className="text-ink">never executed, built or installed</strong>.
        Secret-looking values are masked before anything is sent to the model. Nothing is saved.
      </div>

      <div className="rounded-xl border border-line bg-panel/90 p-4 sm:p-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="code" className="text-sm font-medium text-ink">Code to analyze</label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => { setCode(SAMPLE); setFilename("sample.js"); setError(null); }} className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:text-ink">
              Load insecure sample
            </button>
            <label className="cursor-pointer rounded-md border border-electric/40 bg-electric/10 px-3 py-1.5 text-xs font-medium text-electric-hi hover:bg-electric/20">
              Upload file
              <input type="file" className="sr-only" accept={ALLOWED_EXTENSIONS.join(",")} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          </div>
        </div>
        <textarea
          id="code"
          value={code}
          onChange={(e) => { setCode(e.target.value); }}
          spellCheck={false}
          rows={14}
          placeholder="Paste source code here (JS/TS, Python, Rust, Go, C/C++, Java, Solidity, …)"
          className="w-full resize-y rounded-lg border border-line bg-void/80 px-3 py-2 font-mono text-xs leading-relaxed text-ink placeholder:text-faint focus:border-neon/60 focus:outline-none"
        />
        <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs">
          <span className="text-faint">{filename ? `File: ${filename}` : "Pasted code"}</span>
          <span className={tooBig ? "text-danger" : "text-faint"}>
            {(bytes / 1024).toFixed(1)} / {MAX_CODE_BYTES / 1024} KB
          </span>
        </div>

        <label className="mt-4 flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-neon)]" />
          <span>I am authorized to analyze this code (I own it or have permission from its owner).</span>
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void scan()} disabled={!canScan} className="rounded-lg bg-gradient-to-r from-electric to-neon px-5 py-2 text-sm font-semibold text-void disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? "Scanning…" : "Scan code"}
          </button>
          {busy && <button type="button" onClick={() => abortRef.current?.abort()} className="rounded-lg border border-line px-3 py-2 text-xs text-muted hover:text-ink">Cancel</button>}
          {busy && <span className="text-sm text-muted" role="status">Running pattern checks, then asking the model (10–60 s)…</span>}
        </div>
        {error && <div className="mt-3 text-sm text-danger" role="alert">{error}</div>}
      </div>

      {result && (
        <div className="space-y-4">
          <section className="rounded-xl border border-line bg-panel/90 p-4 sm:p-5">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-electric-hi">AI review</h2>
              <Badge>{result.ai.language}</Badge>
              <Badge tone="info">{result.totalLines} lines</Badge>
              {result.secretsMasked > 0 && <Badge tone="warn">{result.secretsMasked} line(s) had secrets masked before sending</Badge>}
              {!result.structured && <Badge tone="warn">Unstructured model output</Badge>}
            </div>
            <p className="text-sm text-ink/90">{result.ai.summary}</p>

            {result.ai.findings.length === 0 ? (
              <p className="mt-3 text-sm text-muted">The model reported no findings. That does not prove the code is secure.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {result.ai.findings.map((f, i) => (
                  <li key={i} className="rounded-lg border border-line bg-void/50 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={f.severity} />
                      <span className="text-sm font-medium text-ink">{f.title}</span>
                      {f.lines && <Badge tone="info">{f.lines[0] === f.lines[1] ? `line ${f.lines[0]}` : `lines ${f.lines[0]}–${f.lines[1]}`}</Badge>}
                      {f.cwe && <Badge>{f.cwe}</Badge>}
                      <Badge tone={f.confidence === "high" ? "ok" : f.confidence === "medium" ? "warn" : "muted"}>{f.confidence} confidence</Badge>
                    </div>
                    {f.lines && (
                      <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-void/80 p-2 font-mono text-[11px] leading-relaxed text-muted">
                        {lines.slice(f.lines[0] - 1, Math.min(f.lines[1], f.lines[0] + 5)).map((l, j) => `${String(f.lines![0] + j).padStart(4)} | ${l.length > 160 ? `${l.slice(0, 160)}…` : l}`).join("\n")}
                      </pre>
                    )}
                    <p className="mt-2 text-sm text-muted">{f.explanation}</p>
                    <div className="mt-2 text-sm"><span className="font-medium text-ok">Secure fix: </span><span className="text-muted">{f.fix}</span></div>
                  </li>
                ))}
              </ul>
            )}
            {result.ai.limitations && <p className="mt-3 text-xs text-faint">Limitations: {result.ai.limitations}</p>}
          </section>

          <section className="rounded-xl border border-line bg-panel/90 p-4 sm:p-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-electric-hi">Deterministic pre-scan ({result.prescan.length})</h2>
              <button type="button" onClick={() => download("btc-scan-report.json", JSON.stringify({ prescan: result.prescan, ai: result.ai }, null, 2))} className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:text-ink">
                Download JSON
              </button>
            </div>
            <p className="mb-3 text-xs text-faint">Regex pattern checks (no execution). Quick signals, not proof — expect false positives and misses.</p>
            {result.prescan.length === 0 ? (
              <p className="text-sm text-muted">No pattern matches.</p>
            ) : (
              <ul className="space-y-2">
                {result.prescan.map((f, i) => (
                  <li key={i} className="rounded-lg border border-line bg-void/50 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={f.severity} />
                      <span className="text-sm text-ink">{f.title}</span>
                      <Badge tone="info">line {f.line}</Badge>
                    </div>
                    <pre className="mt-2 overflow-x-auto font-mono text-[11px] text-muted">{f.snippet}</pre>
                    <p className="mt-1 text-xs text-muted">{f.advice}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="text-xs text-faint">{result.notice} Model: <span className="font-mono">{result.model}</span>{result.usage ? ` · ${result.usage.totalTokens.toLocaleString()} tokens` : ""}</p>
        </div>
      )}
    </div>
  );
}
