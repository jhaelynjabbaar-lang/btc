export const FETCH_TIMEOUT_MS = 12_000;
export const ONE_HOUR = 3600;

export class SourceError extends Error {
  constructor(
    public kind: "rate_limited" | "unavailable" | "bad_response",
    message: string,
  ) {
    super(message);
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/** fetch with timeout + status classification. Caches via the Next data cache. */
export async function getText(
  url: string,
  opts: { headers?: Record<string, string>; revalidate: number },
): Promise<{ text: string; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: opts.headers,
      next: { revalidate: opts.revalidate },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new SourceError("unavailable", "request failed or timed out");
  }
  if (res.status === 429 || res.status === 403) {
    // GitHub uses 403 for primary rate limits; NVD uses 403/429.
    throw new SourceError("rate_limited", `rate limited (HTTP ${res.status})`);
  }
  if (!res.ok) throw new SourceError("unavailable", `HTTP ${res.status}`);
  return { text: await res.text(), headers: res.headers };
}

export async function getJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; revalidate: number },
): Promise<T> {
  const { text } = await getText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SourceError("bad_response", "invalid JSON");
  }
}

export function errText(e: unknown): string {
  return e instanceof SourceError ? e.message : "unexpected error";
}
