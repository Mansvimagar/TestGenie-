const CACHE_TTL_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 5_000;

let cache: { at: number; names: Set<string> } | null = null;

/**
 * Models this key can call generateContent on, from one models.list request cached for
 * 10 minutes. Returns null when the list is unavailable; callers then use the chain as is.
 * The key is sent in a header and never logged.
 */
export async function getAvailableGenerationModels(
  apiKey: string,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<Set<string> | null> {
  const now = deps.now ?? Date.now;
  if (cache && now() - cache.at < CACHE_TTL_MS) return cache.names;
  try {
    const response = await (deps.fetchImpl ?? fetch)(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) }
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    const names = new Set(
      (body.models ?? [])
        .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => (model.name ?? "").replace(/^models\//, ""))
        .filter(Boolean)
    );
    cache = { at: now(), names };
    return names;
  } catch {
    return null;
  }
}

export function resetModelAvailabilityCache(): void {
  cache = null;
}
