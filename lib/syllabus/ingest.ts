import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectStructure } from "@/lib/pdf/structure";
import { chunkSyllabus } from "@/lib/pdf/chunking";
import { generateEmbeddings } from "@/lib/embeddings";
import { getAIProvider } from "@/lib/ai/provider";
import type { Syllabus, SyllabusOutline, SyllabusSourceType } from "@/types/syllabus";

export class SyllabusIngestError extends Error {}

export interface IngestParams {
  supabase: SupabaseClient;
  userId: string;
  name: string;
  sourceType: SyllabusSourceType;
  /** Already-cleaned text (see lib/pdf/parser.ts#cleanText). */
  cleanedText: string;
  filePath?: string | null;
  pageCount?: number | null;
}

export interface IngestResult {
  syllabus: Syllabus;
  outline: SyllabusOutline;
  chunkCount: number;
}

/**
 * Runs the full "PDF → structure → chunks → embeddings → storage" pipeline
 * (Phase 3) for a syllabus, whether it originally came from a PDF upload or
 * pasted text -- both call this after producing cleaned text, so the RAG
 * pipeline behaves identically regardless of source_type.
 *
 * On failure partway through, the syllabus row is left in `status = 'error'`
 * with `processing_error` set, rather than deleted -- so the faculty member
 * gets a clear error instead of a silent gap, and a future retry path has
 * something to attach to.
 */
export async function ingestSyllabus(params: IngestParams): Promise<IngestResult> {
  const { supabase, userId, name, sourceType, cleanedText, filePath, pageCount } = params;
  const embeddingProvider = getAIProvider();

  const { data: syllabus, error: insertError } = await supabase
    .from("syllabi")
    .insert({
      user_id: userId,
      name,
      source_type: sourceType,
      raw_text: cleanedText,
      file_path: filePath ?? null,
      page_count: pageCount ?? null,
      status: "processing",
    })
    .select()
    .single();

  if (insertError || !syllabus) {
    throw new SyllabusIngestError(`Failed to create syllabus record: ${insertError?.message}`);
  }

  try {
    const structure = detectStructure(cleanedText);
    const pendingChunks = chunkSyllabus(cleanedText, structure);

    if (pendingChunks.length === 0) {
      throw new SyllabusIngestError("No chunkable content was found in this syllabus.");
    }

    const embeddings = await generateEmbeddings(
      pendingChunks.map((c) => c.content),
      embeddingProvider
    );

    const rows = pendingChunks.map((chunk, i) => ({
      syllabus_id: syllabus.id,
      unit: chunk.unit,
      topic: chunk.topic,
      subtopic: chunk.subtopic,
      content: chunk.content,
      chunk_index: chunk.chunkIndex,
      metadata: {
        ...chunk.metadata,
        embeddingProvider,
      },
      // page_start/page_end are intentionally left null: the current PDF
      // extraction path (lib/pdf/parser.ts, using pdf-parse's default text
      // mode) flattens the document into one string with no per-page
      // boundaries, so there is no reliable page number to attach here yet.
      // See the audit's "Known Limitations" for what page-aware extraction
      // would require.
      embedding: embeddings[i],
    }));

    const { error: chunksError } = await supabase.from("syllabus_chunks").insert(rows);
    if (chunksError) {
      throw new SyllabusIngestError(`Failed to store syllabus chunks: ${chunksError.message}`);
    }

    const { data: updated, error: updateError } = await supabase
      .from("syllabi")
      .update({ status: "ready" })
      .eq("id", syllabus.id)
      .select()
      .single();

    if (updateError || !updated) {
      throw new SyllabusIngestError(`Failed to finalize syllabus status: ${updateError?.message}`);
    }

    const outline = buildOutline(updated.id, structure);
    return { syllabus: updated as Syllabus, outline, chunkCount: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error while processing syllabus.";
    await supabase
      .from("syllabi")
      .update({ status: "error", processing_error: message })
      .eq("id", syllabus.id);
    throw err instanceof SyllabusIngestError ? err : new SyllabusIngestError(message);
  }
}

function buildOutline(
  syllabusId: string,
  structure: ReturnType<typeof detectStructure>
): SyllabusOutline {
  return {
    syllabusId,
    structureConfident: structure.confident,
    units: structure.units.map((u) => ({
      name: u.name,
      topics: u.topics.map((t) => ({ name: t.name, subtopics: t.subtopics })),
    })),
  };
}
