"use client";

import { useEffect, useRef, useState } from "react";
import { askResearch } from "@/lib/client/api";
import type { ResearchResult } from "@/lib/ai/research";
import { AnswerView } from "./answer-view";
import { Markdown } from "./markdown";
import { Badge } from "./ui";

type Turn = { id: number; question: string; mode: "chat" | "report"; result?: ResearchResult; error?: string };

const EXAMPLES = [
  "Explain the 2018 CVE-2018-17144 inflation bug",
  "What denial-of-service issues has Bitcoin Core disclosed recently?",
  "How do ECDSA nonce reuse bugs expose private keys?",
];

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";
}

export function ResearchConsole({ initialQuestion, initialMode }: { initialQuestion?: string; initialMode?: "chat" | "report" }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState(initialQuestion ?? "");
  const [mode, setMode] = useState<"chat" | "report">(initialMode ?? "chat");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoRan = useRef(false);

  async function ask(question: string, askMode: "chat" | "report") {
    const q = question.trim();
    if (!q || busy) return;
    const id = ++idRef.current;
    setTurns((t) => [...t, { id, question: q, mode: askMode }]);
    setInput("");
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;

    // Conversation context for follow-ups: last few turns as user/assistant text (chat mode only).
    const history = turns
      .filter((t) => t.result && t.mode === "chat")
      .slice(-2)
      .flatMap((t) => [
        { role: "user" as const, content: t.question.slice(0, 1500) },
        { role: "assistant" as const, content: (t.result as ResearchResult).answer.summary.slice(0, 1500) },
      ]);
    const messages = askMode === "chat" ? [...history, { role: "user" as const, content: q }] : [{ role: "user" as const, content: q }];
    try {
      const result = await askResearch({ messages, mode: askMode }, ac.signal);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, result } : x)));
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: "Cancelled." } : x)));
      } else {
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: e instanceof Error ? e.message : "Request failed." } : x)));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  // Auto-run when launched from a Research preset (?q=...&auto=1).
  useEffect(() => {
    if (initialQuestion && !autoRan.current && initialMode) {
      autoRan.current = true;
      void ask(initialQuestion, initialMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, busy]);

  function download(t: Turn) {
    if (!t.result?.report) return;
    const blob = new Blob([t.result.report.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(t.result.report.title)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-line bg-panel/70 px-4 py-2.5 text-xs text-muted">
        Answers are grounded on live NVD, GitHub advisory and bitcoincore.org data retrieved for each question. Nothing is
        saved — conversations and reports are lost when you leave this page (the database arrives in Stage 6).
      </div>

      <div className="space-y-4">
        {turns.length === 0 && (
          <div className="rounded-xl border border-dashed border-line-hi/70 bg-panel/50 p-5">
            <div className="text-sm font-medium text-ink">Ask a Bitcoin security question</div>
            <p className="mt-1 text-sm text-muted">Defensive and educational use only. Try:</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setInput(e)}
                  className="rounded-full border border-line-hi bg-panel-hi px-3 py-1 text-left text-xs text-electric-hi hover:border-neon/50 hover:text-neon"
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t) => (
          <div key={t.id} className="space-y-3">
            <div className="ml-auto max-w-[90%] rounded-xl border border-electric/30 bg-electric/10 px-4 py-2.5 text-sm text-ink sm:max-w-[80%]">
              <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-electric-hi">
                You {t.mode === "report" && <Badge tone="info">Report</Badge>}
              </div>
              <div className="whitespace-pre-wrap break-words">{t.question}</div>
            </div>
            <div className="rounded-xl border border-line bg-panel/90 p-4 sm:p-5">
              {t.error ? (
                <div className="text-sm text-danger" role="alert">{t.error}</div>
              ) : !t.result ? (
                <div className="flex items-center gap-3 text-sm text-muted" role="status">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-hi border-t-neon" aria-hidden="true" />
                  Retrieving sources, then asking the model… {t.mode === "report" ? "Reports can take up to a minute or two." : "Usually 10–30 seconds."}
                </div>
              ) : t.mode === "report" && t.result.report ? (
                <div>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <Badge tone="info">Detailed report</Badge>
                    <button
                      type="button"
                      onClick={() => download(t)}
                      className="rounded-md border border-neon/40 bg-neon/10 px-3 py-1.5 text-xs font-medium text-neon hover:bg-neon/20"
                    >
                      Download .md
                    </button>
                  </div>
                  <Markdown source={t.result.report.markdown} className="text-ink/90" />
                </div>
              ) : (
                <AnswerView result={t.result} onFollowUp={(q) => void ask(q, "chat")} />
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input, mode);
        }}
        className="sticky bottom-3 rounded-xl border border-line-hi bg-navy-900/95 p-3 shadow-glow backdrop-blur"
      >
        <label htmlFor="q" className="sr-only">Your question</label>
        <textarea
          id="q"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void ask(input, mode);
            }
          }}
          maxLength={4000}
          rows={2}
          placeholder="Ask about a CVE, advisory, release, or Bitcoin security topic…"
          className="w-full resize-y rounded-lg border border-line bg-void/70 px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-neon/60 focus:outline-none"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-lg border border-line p-0.5 text-xs" role="group" aria-label="Mode">
            {(["chat", "report"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={"rounded-md px-3 py-1.5 transition-colors " + (mode === m ? "bg-electric/20 text-electric-hi" : "text-muted hover:text-ink")}
              >
                {m === "chat" ? "Ask" : "Generate detailed report"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-faint sm:inline">{input.length}/4000 · Ctrl+Enter</span>
            {busy && (
              <button type="button" onClick={() => abortRef.current?.abort()} className="rounded-lg border border-line px-3 py-2 text-xs text-muted hover:text-ink">
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded-lg bg-gradient-to-r from-electric to-neon px-4 py-2 text-sm font-semibold text-void disabled:cursor-not-allowed disabled:opacity-40"
            >
              {mode === "report" ? "Generate report" : "Ask"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
