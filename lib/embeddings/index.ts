import "server-only";
import { GoogleGenAI } from "@google/genai";
import { getAIProvider, type AIProvider } from "@/lib/ai/provider";

// Centralizes every embedding API call. Nothing else in the app should
// import "@google/genai" for embeddings directly -- this keeps the provider
// swappable (see EmbeddingError / EMBEDDING_DIMENSION contract below) and
// keeps API-key usage in one server-only module.
//
// Model: Gemini's gemini-embedding-001, output dimension 768. This MUST stay
// in sync with the `vector(768)` column in
// supabase/migrations/002_syllabus_knowledge_base.sql -- pgvector's `vector`
// type has a fixed dimension per column, so changing the model to one with a
// different output size requires a new migration that recreates the column
// (see the comment above that table), not just an env var change here.
export const EMBEDDING_DIMENSION = 768;
const EMBEDDING_MODEL = "gemini-embedding-001";

// Gemini's embedContent endpoint accepts at most 100 inputs per batch call.
const MAX_BATCH_SIZE = 100;

export class EmbeddingError extends Error {}

let cachedClient: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new EmbeddingError(
      "GEMINI_API_KEY is not configured. Embeddings require the same key used for generation."
    );
  }
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

/** Embeds a single string. Prefer generateEmbeddings() when embedding more than one. */
export async function generateEmbedding(text: string): Promise<number[]> {
  const [vector] = await generateEmbeddings([text]);
  return vector;
}

/**
 * Embeds many strings, batching automatically to stay under the provider's
 * per-request item limit. Order of the returned array matches `texts`.
 */
export async function generateEmbeddings(
  texts: string[],
  provider: AIProvider = getAIProvider()
): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (provider === "mock") {
    return texts.map((t) => mockEmbedding(t));
  }

  const client = getClient();
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    try {
      // @google/genai's unified client exposes embedContent on `models`,
      // mirroring generateContent's shape. It accepts either a single
      // string/Content or an array of them via `contents`, and returns
      // `{ embeddings: [{ values: number[] }, ...] }` -- one entry per
      // input, in order. This has not been exercised against a live API
      // key in this environment (no network access here); verify against
      // the installed @google/genai version's types before relying on it
      // in production (see the audit's "Known Limitations" section).
      const response = await client.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: batch,
        config: { outputDimensionality: EMBEDDING_DIMENSION },
      });

      const embeddings = response.embeddings ?? [];
      if (embeddings.length !== batch.length) {
        throw new EmbeddingError(
          `Embedding provider returned ${embeddings.length} vectors for ${batch.length} inputs.`
        );
      }

      for (const e of embeddings) {
        const values = e.values ?? [];
        if (values.length !== EMBEDDING_DIMENSION) {
          throw new EmbeddingError(
            `Embedding provider returned a ${values.length}-dimension vector; expected ${EMBEDDING_DIMENSION}. ` +
              "The configured pgvector column must use the same dimension."
          );
        }
        results.push(values);
      }
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        err instanceof Error ? `Embedding request failed: ${err.message}` : "Embedding request failed."
      );
    }
  }

  return results;
}

/**
 * Deterministic, dependency-free "embedding" used only when
 * AI_PROVIDER=mock, so local/mock-mode development never calls a real
 * embedding API. It is NOT semantically meaningful -- it's a fixed-length
 * hash of the text, good enough to exercise storage, pgvector round-trips,
 * and the retrieval code path, but cosine similarity between two mock
 * embeddings does not reflect real semantic similarity.
 */
function mockEmbedding(text: string): number[] {
  const vector = new Array(EMBEDDING_DIMENSION).fill(0);
  for (let i = 0; i < text.length; i++) {
    vector[i % EMBEDDING_DIMENSION] += text.charCodeAt(i);
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/** Cosine similarity between two equal-length vectors, in [-1, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new EmbeddingError(`Cannot compare vectors of differing length (${a.length} vs ${b.length}).`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
