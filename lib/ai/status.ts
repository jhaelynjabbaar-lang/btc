import "server-only";
import { getAiConfig } from "./config";
import { AiError, chatCompletion, checkKey, checkModelListed } from "./openrouter";

export type AiStatus = {
  provider: "OpenRouter";
  model: string;
  /** An API key is present in the server environment. */
  configured: boolean;
  /**
   * true  = provider accepted the key and lists the model (or, with probe, answered a real completion)
   * false = a check failed
   * null  = not checked (not configured)
   */
  working: boolean | null;
  /** How `working` was determined. */
  check: "none" | "key+model" | "completion";
  /** Safe error code when working === false. */
  error: string | null;
};

/**
 * Cheap health check. By default uses two free metadata calls (cached 5 min); with `probe`
 * it makes one tiny real completion (costs a fraction of a cent). Never returns the key.
 */
export async function getAiStatus(opts: { probe?: boolean } = {}): Promise<AiStatus> {
  const cfg = getAiConfig();
  const base = { provider: "OpenRouter" as const, model: cfg.model, configured: cfg.configured };
  if (!cfg.configured) return { ...base, working: null, check: "none", error: null };

  try {
    if (opts.probe) {
      await chatCompletion({
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        maxTokens: 200,
        temperature: 0,
        timeoutMs: 20_000,
      });
      return { ...base, working: true, check: "completion", error: null };
    }
    if (!(await checkKey())) return { ...base, working: false, check: "key+model", error: "provider_auth" };
    if (!(await checkModelListed())) return { ...base, working: false, check: "key+model", error: "model_not_listed" };
    return { ...base, working: true, check: "key+model", error: null };
  } catch (err) {
    const code = err instanceof AiError ? err.code : "provider_unavailable";
    return { ...base, working: false, check: opts.probe ? "completion" : "key+model", error: code };
  }
}
