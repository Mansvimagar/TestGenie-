// gemini-3.8-flash is listed by the API for this key but never answers generateContent
// (verified: trivial prompts hang past 120s while gemini-3.5-flash answers in ~3s).
// GEMINI_MODEL is intentionally not reused: it is documented as gemini-2.0-flash,
// which now returns 404 for new keys.
export const DEFAULT_GENERATION_MODEL = "gemini-3.5-flash";

/** Request timeout so a silent provider fails in bounded time instead of Node's ~300s fetch default. */
export const GENERATION_TIMEOUT_MS = 90_000;

export function resolveGenerationModel(env: Record<string, string | undefined> = process.env): string {
  const override = env.GEMINI_GENERATION_MODEL?.trim();
  return override && /^[\w.-]{1,80}$/.test(override) ? override : DEFAULT_GENERATION_MODEL;
}
