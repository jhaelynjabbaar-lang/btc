import type { ResearchResult } from "@/lib/ai/research";

export type ApiError = { error: string; message: string };

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error("Network error — could not reach the server.");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const d = data as Partial<ApiError> | null;
    const retry = res.headers.get("retry-after");
    const extra = res.status === 429 && retry ? ` Try again in ${retry}s.` : "";
    throw new Error(`${d?.message ?? `Request failed (HTTP ${res.status}).`}${extra}`);
  }
  return data as T;
}

export function askResearch(
  body: { messages: Array<{ role: "user" | "assistant"; content: string }>; mode: "chat" | "report"; focus?: string },
  signal?: AbortSignal,
) {
  return postJson<ResearchResult>("/api/ai/chat", body, signal);
}

export function runScanRequest(
  body: { code: string; filename?: string; authorized: true },
  signal?: AbortSignal,
) {
  return postJson<import("@/lib/ai/scan").ScanResult>("/api/scan", body, signal);
}
