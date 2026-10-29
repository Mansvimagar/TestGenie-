// gemini-3.8-flash is listed by the API for this key but never answers generateContent
// (verified: trivial prompts hang past 120s while gemini-3.5-flash answers in ~3s).
// GEMINI_MODEL is intentionally not reused: it is documented as gemini-2.0-flash,
// which now returns 404 for new keys.
export const DEFAULT_GENERATION_MODEL = "gemini-3.5-flash";

// Models that answered generateContent for this key, stable before preview. Models
// that hung (3.8/3.7-flash, flash-latest) or returned 404 (2.x) are deliberately absent.
export const DEFAULT_MODEL_CHAIN = [
  DEFAULT_GENERATION_MODEL,
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
] as const;

/** Per-call timeout so a silent provider fails in bounded time instead of Node's ~300s fetch default. */
export const GENERATION_TIMEOUT_MS = 90_000;
/** Retry budget for one batch: attempts, backoff and model fallbacks all stop at this point. */
export const BATCH_RETRY_BUDGET_MS = 100_000;
/** Budget for all Gemini generation in one request; /api/generate maxDuration must exceed this. */
export const REQUEST_GENERATION_BUDGET_MS = 240_000;
export const MAX_BATCH_QUESTIONS = 5;

const MODEL_NAME = /^[\w.-]{1,80}$/;

export function resolveGenerationModel(env: Record<string, string | undefined> = process.env): string {
  const override = env.GEMINI_GENERATION_MODEL?.trim();
  return override && MODEL_NAME.test(override) ? override : DEFAULT_GENERATION_MODEL;
}

/**
 * Ordered fallback chain. GEMINI_MODEL_CHAIN (comma-separated model names) replaces the
 * default; otherwise GEMINI_GENERATION_MODEL, when set, is tried first. Invalid names are dropped.
 */
export function resolveModelChain(env: Record<string, string | undefined> = process.env): string[] {
  const configured = (env.GEMINI_MODEL_CHAIN ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => MODEL_NAME.test(name));
  if (configured.length > 0) return [...new Set(configured)];
  return [...new Set([resolveGenerationModel(env), ...DEFAULT_MODEL_CHAIN])];
}

/** Drops models the key cannot use. An unknown or non-overlapping list leaves the chain unchanged. */
export function filterAvailableModels(chain: string[], available: Set<string> | null): string[] {
  if (!available || available.size === 0) return chain;
  const usable = chain.filter((name) => available.has(name));
  return usable.length > 0 ? usable : chain;
}

export type ProviderFailureKind =
  | "busy"
  | "rate_limit"
  | "timeout"
  | "model_unavailable"
  | "config"
  | "malformed"
  | "unknown";

export class ProviderCallError extends Error {
  constructor(readonly kind: ProviderFailureKind) {
    super(`provider call failed: ${kind}`);
    this.name = "ProviderCallError";
  }
}

export function classifyProviderError(err: unknown): ProviderFailureKind {
  if (err instanceof ProviderCallError) return err.kind;
  const record = (err && typeof err === "object" ? err : {}) as Record<string, unknown>;
  const text = err instanceof Error ? `${err.name} ${err.message}` : "";
  const status = Number(record.status ?? record.statusCode ?? record.code);
  const embedded = Number(/"code"\s*:\s*(\d{3})/.exec(text)?.[1]);
  const code = Number.isInteger(status) && status >= 100 ? status : embedded;

  if (code === 503 || code === 500 || code === 502 || /UNAVAILABLE|high demand|overloaded/i.test(text)) return "busy";
  if (code === 429 || /RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(text)) return "rate_limit";
  if (
    code === 504 || code === 408 ||
    /DEADLINE_EXCEEDED|TimeoutError|AbortError|timed? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|UND_ERR|fetch failed/i.test(text)
  ) return "timeout";
  if (code === 404 || /NOT_FOUND/.test(text)) return "model_unavailable";
  if (code === 400 || code === 401 || code === 403 || /INVALID_ARGUMENT|PERMISSION_DENIED|UNAUTHENTICATED|API key/i.test(text)) return "config";
  return "unknown";
}

/** 429/5xx or a timeout/network failure: worth retrying. Auth, bad-request and not-found errors are not. */
export function isTransientProviderError(err: unknown): boolean {
  const kind = classifyProviderError(err);
  return kind === "busy" || kind === "rate_limit" || kind === "timeout";
}

export interface FallbackOptions<T> {
  models: string[];
  call: (model: string, timeoutMs: number) => Promise<T>;
  budgetMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onFailure?: (info: { model: string; attempt: number; kind: ProviderFailureKind; elapsedMs: number }) => void;
}

/**
 * Calls through the model chain. Transient failures (503/429/timeout/network) and malformed
 * output rotate to the next model after exponential backoff with jitter, within a total time
 * budget. A 404 skips that model with no wait; 400/401/403 and unknown errors fail immediately.
 */
export async function runWithFallback<T>(options: FallbackOptions<T>): Promise<T> {
  const {
    models,
    call,
    budgetMs = BATCH_RETRY_BUDGET_MS,
    maxAttempts = 8,
    baseDelayMs = 1_000,
    maxDelayMs = 8_000,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    onFailure,
  } = options;
  if (models.length === 0) throw new ProviderCallError("config");

  const start = now();
  const deadline = start + budgetMs;
  const unusable = new Set<number>();
  let index = 0;
  let attempt = 0;
  let malformed = 0;
  let last: ProviderFailureKind | null = null;

  const nextIndex = () => {
    for (let step = 1; step <= models.length; step++) {
      const candidate = (index + step) % models.length;
      if (!unusable.has(candidate)) return candidate;
    }
    return index;
  };

  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new ProviderCallError(last ?? "timeout");
    if (attempt >= maxAttempts) throw new ProviderCallError(last ?? "unknown");
    attempt += 1;
    const model = models[index];
    const attemptStart = now();
    try {
      return await call(model, Math.min(GENERATION_TIMEOUT_MS, remaining));
    } catch (err) {
      const kind = classifyProviderError(err);
      last = kind;
      onFailure?.({ model, attempt, kind, elapsedMs: now() - attemptStart });

      if (kind === "config" || kind === "unknown") throw new ProviderCallError(kind);
      if (kind === "model_unavailable") {
        unusable.add(index);
        if (unusable.size >= models.length) throw new ProviderCallError("config");
        index = nextIndex();
        continue;
      }
      if (kind === "malformed" && ++malformed >= 2) throw new ProviderCallError("malformed");

      index = nextIndex();
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(cap * (0.5 + random() * 0.5));
      if (delay >= deadline - now()) throw new ProviderCallError(kind);
      await sleep(delay);
    }
  }
}

/** Splits a request into batches of at most MAX_BATCH_QUESTIONS, sizes as even as possible. */
export function planBatches(total: number, max = MAX_BATCH_QUESTIONS): number[] {
  if (total <= 0) return [];
  const count = Math.ceil(total / max);
  const base = Math.floor(total / count);
  const extra = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

// Safe, user-facing text per failure kind. Provider details never reach the UI.
export const SAFE_FAILURE_MESSAGES: Record<ProviderFailureKind, string> = {
  busy: "The AI service is busy right now. Please wait a minute and try again.",
  rate_limit: "The AI service rate limit or quota was reached. Please wait a few minutes and try again.",
  timeout: "The AI service took too long to respond. Please try again.",
  model_unavailable: "AI generation is not configured correctly on the server. Contact the administrator.",
  config: "AI generation is not configured correctly on the server. Contact the administrator.",
  malformed: "The AI returned incomplete or malformed MCQs after two attempts. Please retry or reduce the requested count.",
  unknown: "Grounded AI generation failed. Please try again.",
};

export function httpStatusForFailure(kind: ProviderFailureKind): number {
  switch (kind) {
    case "busy": return 503;
    case "rate_limit": return 429;
    case "timeout": return 504;
    case "config":
    case "model_unavailable": return 503;
    default: return 422;
  }
}
