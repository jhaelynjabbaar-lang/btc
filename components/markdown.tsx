import type { ReactNode } from "react";

/** Minimal, dependency-free markdown renderer (headings, lists, bold, code, https links). No raw HTML is ever rendered. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|<https?:\/\/[^>\s]+>|https?:\/\/[^\s)<]+)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    const linkCls = "text-electric-hi underline decoration-electric/40 underline-offset-2 hover:text-neon break-words";
    if (tok.startsWith("**")) out.push(<strong key={key} className="font-semibold text-ink">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key} className="rounded bg-void/70 px-1 py-0.5 font-mono text-[0.85em] text-neon">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const lm = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      out.push(lm ? <a key={key} href={lm[2]} target="_blank" rel="noopener noreferrer" className={linkCls}>{lm[1]}</a> : tok);
    } else {
      const url = tok.replace(/^<|>$/g, "");
      out.push(<a key={key} href={url} target="_blank" rel="noopener noreferrer" className={linkCls}>{url}</a>);
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let list: string[] = [];
  let para: string[] = [];
  let k = 0;
  const flushList = () => {
    if (!list.length) return;
    blocks.push(
      <ul key={`ul${k++}`} className="my-2 list-disc space-y-1 pl-5 marker:text-neon/70">
        {list.map((t, i) => <li key={i}>{inline(t, `li${k}-${i}`)}</li>)}
      </ul>,
    );
    list = [];
  };
  const flushPara = () => {
    if (!para.length) return;
    blocks.push(<p key={`p${k++}`} className="my-2 leading-relaxed">{inline(para.join(" "), `p${k}`)}</p>);
    para = [];
  };
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (h) {
      flushList(); flushPara();
      const lvl = h[1].length;
      blocks.push(
        <div key={`h${k++}`} className={(lvl <= 2 ? "mt-5 text-base font-semibold text-electric-hi " : "mt-3 text-sm font-semibold text-ink ") + "tracking-tight"}>
          {inline(h[2], `h${k}`)}
        </div>,
      );
    } else if (li) { flushPara(); list.push(li[1]); }
    else if (line.startsWith(">")) { flushList(); flushPara(); blocks.push(<blockquote key={`q${k++}`} className="my-2 border-l-2 border-line-hi pl-3 text-sm text-muted">{inline(line.replace(/^>\s?/, ""), `q${k}`)}</blockquote>); }
    else if (!line.trim()) { flushList(); flushPara(); }
    else { flushList(); para.push(line.trim()); }
  }
  flushList(); flushPara();
  return <div className={"text-sm text-muted " + className}>{blocks}</div>;
}
