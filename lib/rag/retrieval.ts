import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "@/lib/embeddings";
import type { RetrievedChunk } from "@/types/generation";
import {
  filterChunksToScope,
  matchesChunkScope,
  type RetrievalScope,
} from "./scope";

export class RetrievalError extends Error {}

const DEFAULT_MATCH_COUNT = 12;

export interface RetrievalParams {
  syllabusId: string;
  unit?: string | null;
  topic?: string | null;
  subtopic?: string | null;
  includedTopics?: string[];
  excludedTopics?: string[];
  additionalInstructions?: string;
  subject?: string;
  matchCount?: number;
}

interface MatchRpcRow {
  id: string;
  syllabus_id: string;
  unit: string | null;
  topic: string | null;
  subtopic: string | null;
  content: string;
  page_start: number | null;
  page_end: number | null;
  similarity: number;
  metadata?: Record<string, unknown>;
}

/**
 * Retrieves the syllabus content most relevant to a generation request.
 *
 * Supports every mode described in the spec through one unified path:
 *  - "whole syllabus": call with only `syllabusId` -- unit/topic filters are
 *    null, so the RPC ranks across the entire syllabus by semantic
 *    similarity to a query built from subject/instructions.
 *  - "unit filtering" / "topic filtering": pass `unit` and/or `topic` --
 *    these become exact metadata filters in the SQL function, combined with
 *    semantic ranking within that scope (matches SRS FR-16's "combined
 *    metadata filtering and semantic search").
 *  - "semantic query": pass `additionalInstructions` (or rely on
 *    unit/topic/subtopic text itself) -- it's embedded and used as the
 *    ranking vector in all of the above.
 *
 * Scope filters are passed to the database RPC and rechecked on returned
 * metadata. A sparse or empty result stays sparse or empty; it is never
 * widened to unrelated syllabus chunks.
 */
export async function retrieveChunks(
  supabase: SupabaseClient,
  params: RetrievalParams
): Promise<RetrievedChunk[]> {
  const queryText = buildQueryText(params);
  const queryEmbedding = await generateEmbedding(queryText);
  const targetCount = normalizeMatchCount(params.matchCount);
  const rpcScope = {
    syllabusId: params.syllabusId,
    unit: params.unit ?? null,
    topic: params.topic ?? null,
  };

  // The RPC filters syllabus/unit/topic before ranking and limiting. Optional
  // subtopic/topic-list filters are applied locally, so expand the ranked
  // candidate window until enough eligible chunks are found or the RPC result
  // is exhausted. This avoids mistaking a sparse top-12 post-filter result for
  // an empty selected scope.
  let matchCount = targetCount;
  for (;;) {
    const candidates = await runMatch(supabase, queryEmbedding, {
      ...rpcScope,
      matchCount,
    });
    const filtered = filterChunksToScope(candidates, params);
    if (filtered.length >= targetCount || candidates.length < matchCount) {
      return filtered.slice(0, targetCount);
    }
    if (matchCount >= MAX_SCOPE_CANDIDATES) {
      throw new RetrievalError("Could not safely complete retrieval for the selected syllabus scope.");
    }
    matchCount = Math.min(matchCount * 2, MAX_SCOPE_CANDIDATES);
  }
}

const MAX_SCOPE_CANDIDATES = 4096;

function normalizeMatchCount(value?: number): number {
  if (!Number.isInteger(value) || !value || value < 1) return DEFAULT_MATCH_COUNT;
  return Math.min(value, MAX_SCOPE_CANDIDATES);
}

async function runMatch(
  supabase: SupabaseClient,
  queryEmbedding: number[],
  opts: { syllabusId: string; unit: string | null; topic: string | null; matchCount: number }
): Promise<RetrievedChunk[]> {
  const expectedScope: RetrievalScope = {
    syllabusId: opts.syllabusId,
    unit: opts.unit,
    topic: opts.topic,
  };
  const { data, error } = await supabase.rpc("match_syllabus_chunks", {
    query_embedding: queryEmbedding,
    match_syllabus_id: opts.syllabusId,
    match_unit: opts.unit,
    match_topic: opts.topic,
    match_count: opts.matchCount,
  });

  if (error) {
    throw new RetrievalError(`Syllabus retrieval failed: ${error.message}`);
  }

  return ((data ?? []) as MatchRpcRow[]).map((row) => {
    if (
      row.syllabus_id !== opts.syllabusId ||
      (opts.unit !== null && row.unit !== opts.unit) ||
      (opts.topic !== null && row.topic !== opts.topic)
    ) {
      throw new RetrievalError("Retrieval returned a chunk outside the requested syllabus scope.");
    }
    const embeddingProvider = row.metadata?.embeddingProvider;
    const chunk: RetrievedChunk = {
      chunkId: row.id,
      syllabusId: row.syllabus_id,
      content: row.content,
      unit: row.unit,
      topic: row.topic,
      subtopic: row.subtopic,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      similarity: row.similarity,
      embeddingProvider: embeddingProvider === "mock" || embeddingProvider === "gemini"
        ? embeddingProvider
        : undefined,
    };
    if (!matchesChunkScope(chunk, expectedScope)) {
      throw new RetrievalError("Retrieval returned a chunk outside the requested syllabus scope.");
    }
    return chunk;
  });
}

function buildQueryText(params: RetrievalParams): string {
  const parts = [
    params.unit,
    params.topic,
    params.subtopic,
    ...(params.includedTopics ?? []),
    params.additionalInstructions,
    params.subject,
  ].filter((p): p is string => Boolean(p && p.trim()));

  return parts.length > 0 ? parts.join(". ") : "core syllabus content";
}
