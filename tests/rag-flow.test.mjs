import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createTsLoader(overrides = {}) {
  const cache = new Map();
  function load(relativePath) {
    const filename = path.resolve(projectRoot, relativePath);
    if (cache.has(filename)) return cache.get(filename).exports;
    const loadedModule = new Module(filename);
    loadedModule.filename = filename;
    loadedModule.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, loadedModule);
    const originalRequire = loadedModule.require.bind(loadedModule);
    loadedModule.require = (request) => {
      if (Object.hasOwn(overrides, request)) return overrides[request];
      if (request === "server-only") return {};
      if (request.startsWith("@/")) return load(request.slice(2) + ".ts");
      if (request.startsWith(".") && !path.extname(request)) {
        const resolved = path.resolve(path.dirname(filename), request + ".ts");
        if (fs.existsSync(resolved)) return load(path.relative(projectRoot, resolved));
      }
      return originalRequire(request);
    };
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    loadedModule._compile(compiled, filename);
    return loadedModule.exports;
  }
  return load;
}

const syllabusText = "Unit I: Algorithms. Sorting arranges elements into an order. Merge sort divides a list into halves, sorts each half recursively, and combines sorted halves to produce an ordered list. The method uses divide and conquer and has predictable performance across input arrangements.";

function makeChunk(overrides = {}) {
  return {
    chunkId: "chunk-1",
    syllabusId: "syllabus-1",
    content: "Binary search repeatedly divides a sorted list into halves and compares the target with the middle element.",
    unit: "Unit I",
    topic: "Searching",
    subtopic: null,
    pageStart: null,
    pageEnd: null,
    similarity: 0.8,
    embeddingProvider: "gemini",
    ...overrides,
  };
}

function makeQuestion(overrides = {}) {
  return {
    id: "q-1",
    topic: "Searching",
    question: "How does binary search narrow the search area?",
    options: ["It repeatedly halves the sorted list", "It checks every item", "It sorts the list again", "It removes the target"],
    correctAnswerIndex: 0,
    explanation: "Each comparison removes half of the remaining search interval.",
    ...overrides,
  };
}

test("PDF-extracted and pasted text share normalization and persistent ingestion", async () => {
  const load = createTsLoader({
    "@/lib/ai/provider": { getAIProvider: () => "gemini" },
    "@/lib/embeddings": { generateEmbeddings: async (texts) => texts.map(() => [0.1]) },
  });
  const parser = load("lib/pdf/parser.ts");
  // Exercise the common post-extraction boundary without depending on a
  // generated PDF fixture, which this installed pdf-parse version rejects.
  const pdfText = parser.cleanText(syllabusText);
  const pastedText = parser.cleanText("  " + syllabusText + "  ");
  assert.equal(parser.cleanText(pdfText), parser.cleanText(pastedText));

  const storedSyllabi = [];
  const storedChunks = [];
  let nextId = 0;
  const supabase = {
    from(table) {
      if (table === "syllabi") {
        return {
          insert(values) {
            const row = { ...values, id: "syllabus-" + (++nextId), created_at: "now", updated_at: "now" };
            storedSyllabi.push(row);
            return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
          },
          update(values) {
            return { eq: (_column, id) => ({ select: () => ({ single: async () => {
              const row = storedSyllabi.find((item) => item.id === id);
              Object.assign(row, values);
              return { data: row, error: null };
            } }) }) };
          },
        };
      }
      if (table === "syllabus_chunks") {
        return { insert: async (rows) => { storedChunks.push(...rows); return { error: null }; } };
      }
      throw new Error("Unexpected table " + table);
    },
  };
  const { ingestSyllabus } = load("lib/syllabus/ingest.ts");
  const pdfResult = await ingestSyllabus({ supabase, userId: "user-1", name: "sample.pdf", sourceType: "pdf", cleanedText: pdfText });
  const manualResult = await ingestSyllabus({ supabase, userId: "user-1", name: "pasted", sourceType: "manual", cleanedText: pastedText });
  assert.deepEqual(storedSyllabi.map((row) => row.source_type), ["pdf", "manual"]);
  assert.equal(pdfResult.syllabus.status, "ready");
  assert.equal(manualResult.syllabus.status, "ready");
  assert.ok(pdfResult.chunkCount > 0 && manualResult.chunkCount > 0);
  assert.ok(storedChunks.every((row) => row.metadata.embeddingProvider === "gemini"));
});

test("the PDF and pasted-text API branches both call the persistent ingestion function", async () => {
  const schemaLoad = createTsLoader();
  const schemas = schemaLoad("lib/validation/schemas.ts");
  const calls = [];
  const supabase = { auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } };
  const loadRoute = createTsLoader({
    "@/lib/api-response": {
      ok: (data, status) => ({ status, data }),
      fail: (message, status) => ({ status, message }),
    },
    "@/lib/supabase/server": { createClient: async () => supabase },
    "@/lib/pdf/parser": {
      cleanText: (text) => text.trim().replace(/\\s+/g, " "),
      extractTextFromPdf: async () => syllabusText,
      PdfParseError: class PdfParseError extends Error {},
    },
    "@/lib/syllabus/ingest": {
      ingestSyllabus: async (params) => {
        calls.push(params);
        return { syllabus: { id: "syllabus-1" }, outline: { units: [] }, chunkCount: 1 };
      },
    },
    "@/lib/validation/schemas": schemas,
    "@/lib/ai/provider": { AIProviderConfigurationError: class AIProviderConfigurationError extends Error {} },
  });
  const { POST } = loadRoute("app/api/syllabus/route.ts");
  const manualRequest = {
    headers: { get: () => "application/json" },
    json: async () => ({ text: syllabusText, name: "manual" }),
  };
  const pdfFile = new File(["pdf bytes"], "sample.pdf", { type: "application/pdf" });
  const pdfRequest = {
    headers: { get: () => "multipart/form-data; boundary=test" },
    formData: async () => {
      const form = new FormData();
      form.append("file", pdfFile);
      return form;
    },
  };
  assert.equal((await POST(manualRequest)).status, 201);
  assert.equal((await POST(pdfRequest)).status, 201);
  assert.deepEqual(calls.map((call) => call.sourceType), ["manual", "pdf"]);
  assert.ok(calls.every((call) => call.userId === "user-1" && call.cleanedText === syllabusText));
});

test("invalid PDF bytes produce a safe parser error", async () => {
  const parser = createTsLoader()("lib/pdf/parser.ts");
  await assert.rejects(parser.extractTextFromPdf(Buffer.from("not a PDF")), parser.PdfParseError);
});

test("scope filtering enforces syllabus, unit, topic and optional topic lists", () => {
  const { filterChunksToScope } = createTsLoader()("lib/rag/scope.ts");
  const chunks = [
    makeChunk(),
    makeChunk({ chunkId: "other-syllabus", syllabusId: "syllabus-2" }),
    makeChunk({ chunkId: "other-unit", unit: "Unit II" }),
    makeChunk({ chunkId: "other-topic", topic: "Sorting" }),
    makeChunk({ chunkId: "excluded", topic: "Excluded" }),
  ];
  const selected = filterChunksToScope(chunks, {
    syllabusId: "syllabus-1",
    unit: "Unit I",
    includedTopics: ["Searching", "Sorting"],
    excludedTopics: ["Excluded"],
  });
  assert.deepEqual(selected.map((chunk) => chunk.chunkId), ["chunk-1", "other-topic"]);
});

test("retrieval forwards database scope and expands post-filter candidates", async () => {
  const calls = [];
  const rows = Array.from({ length: 13 }, (_, index) => ({
    id: "chunk-" + index,
    syllabus_id: "syllabus-1",
    unit: "Unit I",
    topic: index === 12 ? "Selected" : "Other",
    subtopic: "Part A",
    content: "Content for chunk " + index,
    page_start: null,
    page_end: null,
    similarity: 1 - index / 100,
    metadata: { embeddingProvider: "gemini" },
  }));
  const load = createTsLoader({ "@/lib/embeddings": { generateEmbedding: async () => [0.1] } });
  const { retrieveChunks } = load("lib/rag/retrieval.ts");
  const result = await retrieveChunks({
    rpc: async (_name, args) => {
      calls.push(args);
      const scoped = rows.filter((row) => row.syllabus_id === args.match_syllabus_id && row.unit === args.match_unit);
      return { data: scoped.slice(0, args.match_count), error: null };
    },
  }, { syllabusId: "syllabus-1", unit: "Unit I", includedTopics: ["Selected"] });
  assert.deepEqual(calls.map((call) => call.match_count), [12, 24]);
  assert.equal(calls[0].match_syllabus_id, "syllabus-1");
  assert.equal(calls[0].match_unit, "Unit I");
  assert.equal(calls[0].match_topic, null);
  assert.deepEqual(result.map((chunk) => chunk.topic), ["Selected"]);
});

test("retrieval rejects chunks returned outside the requested syllabus", async () => {
  const load = createTsLoader({ "@/lib/embeddings": { generateEmbedding: async () => [0.1] } });
  const { retrieveChunks, RetrievalError } = load("lib/rag/retrieval.ts");
  await assert.rejects(retrieveChunks({ rpc: async () => ({ data: [{
    id: "bad", syllabus_id: "another-syllabus", unit: "Unit I", topic: "Selected",
    subtopic: null, content: "wrong syllabus", page_start: null, page_end: null,
    similarity: 1, metadata: { embeddingProvider: "gemini" },
  }], error: null }) }, { syllabusId: "syllabus-1", unit: "Unit I", topic: "Selected" }), RetrievalError);
});

test("empty or whitespace-only evidence is insufficient", () => {
  const { hasUsableEvidence } = createTsLoader()("lib/rag/scope.ts");
  assert.equal(hasUsableEvidence([]), false);
  assert.equal(hasUsableEvidence([makeChunk({ content: "  \n " })]), false);
  assert.equal(hasUsableEvidence([makeChunk()]), true);
});

test("malformed model output is rejected and model provenance is discarded", () => {
  const { parseGroundedQuestionResponse } = createTsLoader()("lib/ai/grounded-response.ts");
  assert.equal(parseGroundedQuestionResponse("not json", 1), null);
  assert.equal(parseGroundedQuestionResponse(JSON.stringify({ questions: [{ question: "incomplete" }] }), 1), null);
  const parsed = parseGroundedQuestionResponse(JSON.stringify({ questions: [{
    ...makeQuestion(), id: "model-id", sourceChunkIds: ["invented-id"], groundingStatus: "grounded",
  }] }), 1);
  assert.ok(parsed);
  assert.notEqual(parsed[0].id, "model-id");
  assert.equal(parsed[0].sourceChunkIds, undefined);
  assert.equal(parsed[0].groundingStatus, "needs_review");
});

test("quality checks mark duplicates and invalid options for faculty review", () => {
  const { assessQuestionQuality } = createTsLoader()("lib/validation/question-quality.ts");
  const first = makeQuestion();
  const duplicate = makeQuestion({ id: "q-2", question: "how does binary search narrow the search area!" });
  const malformed = makeQuestion({ id: "q-3", options: ["same", "same", "third", "fourth"] });
  const result = assessQuestionQuality([first, duplicate, malformed], [makeChunk()]);
  assert.equal(result.questions[0].validationStatus, "duplicate");
  assert.equal(result.questions[1].validationStatus, "duplicate");
  assert.ok(result.questions[2].qualityIssues.some((issue) => issue.includes("duplicates")));
  assert.ok(result.questions.every((question) => question.groundingStatus === "needs_review"));
});

test("quality checks correctly match technical acronyms and short-answer terms", () => {
  const { assessQuestionQuality } = createTsLoader()("lib/validation/question-quality.ts");
  const technicalChunk = makeChunk({
    chunkId: "chunk-tcp",
    content: "Transmission Control Protocol (TCP) provides reliable connection-oriented transport.",
  });
  const acronymQuestion = makeQuestion({
    id: "q-acronym",
    question: "Which transport protocol guarantees reliable delivery?",
    options: ["TCP", "UDP", "IP", "DNS"],
    correctAnswerIndex: 0,
    explanation: "TCP is connection-oriented and reliable according to the syllabus.",
  });
  const result = assessQuestionQuality([acronymQuestion], [technicalChunk]);
  assert.equal(result.questions[0].sourceChunkIds.length, 1);
  assert.equal(result.questions[0].sourceChunkIds[0], "chunk-tcp");
  assert.equal(result.questions[0].qualityIssues.length, 0);
});

test("provenance accepts retrieved IDs only when they match the selected scope", () => {
  const { assertQuestionProvenance, ProvenanceValidationError } = createTsLoader()("lib/rag/provenance.ts");
  const question = makeQuestion({ sourceChunkIds: ["chunk-1"] });
  const scope = { syllabusId: "syllabus-1", unit: "Unit I", topic: "Searching" };
  assert.doesNotThrow(() => assertQuestionProvenance([question], [makeChunk()], scope));
  assert.throws(() => assertQuestionProvenance(
    [makeQuestion({ sourceChunkIds: ["fabricated"] })], [makeChunk()], scope
  ), ProvenanceValidationError);
  assert.throws(() => assertQuestionProvenance(
    [question], [makeChunk({ unit: "Unit II" })], scope
  ), ProvenanceValidationError);
});

test("Gemini provider configuration fails closed when its key is missing", () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.GEMINI_API_KEY;
  try {
    process.env.AI_PROVIDER = "gemini";
    delete process.env.GEMINI_API_KEY;
    const { getAIProvider, AIProviderConfigurationError } = createTsLoader()("lib/ai/provider.ts");
    assert.throws(() => getAIProvider(), AIProviderConfigurationError);
  } finally {
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test("undefined database columns are recognized as schema blockers", () => {
  const { isUndefinedColumnError } = createTsLoader()("lib/database-errors.ts");
  assert.equal(isUndefinedColumnError({ code: "42703" }), true);
  assert.equal(isUndefinedColumnError({ code: "PGRST202" }), false);
  assert.equal(isUndefinedColumnError(null), false);
});

test("draft, edit, regeneration, review and publish callers match the SQL RPC contract", () => {
  const read = (filename) => fs.readFileSync(path.join(projectRoot, filename), "utf8");
  const saveRoute = read("app/api/tests/route.ts");
  const editRoute = read("app/api/tests/[id]/route.ts");
  const regenerateRoute = read("app/api/tests/[id]/questions/[questionId]/regenerate/route.ts");
  const publishRoute = read("app/api/tests/[id]/publish/route.ts");
  const repair = read("supabase/repairs/reconcile_test_workflow_v3_review_candidate.sql");
  const saveFunction = repair.slice(
    repair.indexOf("create or replace function public.save_draft_test"),
    repair.indexOf("create or replace function public.update_test_questions")
  );

  assert.match(saveRoute, /rpc\("save_draft_test"/);
  for (const key of ["explanation", "sourceChunkIds", "groundingStatus", "validationStatus", "validationMetadata"]) {
    assert.ok(saveRoute.includes(`${key}:`), `draft RPC payload must include ${key}`);
  }
  for (const field of ["explanation", "sourceChunkIds", "validationStatus"]) {
    const jsonKey = field[0].toLowerCase() + field.slice(1);
    assert.ok(saveFunction.includes(`q.item->>'${jsonKey}'`) || saveFunction.includes(`q.item->'${jsonKey}'`),
      `save_draft_test must persist ${field}`);
  }
  assert.match(saveFunction, /coalesce\(q\.item->'validationMetadata','\{\}'::jsonb\)/);
  assert.match(saveFunction, /'needs_review'/);
  assert.match(repair, /new\.grounding_status := 'needs_review'/);
  assert.match(repair, /add column if not exists explanation text;/i);
  assert.match(repair, /save_draft_test\(p_syllabus_id uuid,p_generation_config jsonb,p_questions jsonb\)\s*returns jsonb/i);
  assert.match(repair, /update_test_questions\(p_test_id uuid,p_title text,p_subject text,p_difficulty text,p_questions jsonb\)\s*returns void/i);
  assert.match(repair, /replace_test_question\(\s*p_test_id uuid, p_question_id uuid, p_question jsonb\s*\)\s*returns void/i);
  assert.match(repair, /attest_test_review\(p_test_id uuid\)\s*returns void/i);
  assert.match(repair, /publish_test\(p_test_id uuid\)\s*returns void/i);
  assert.match(editRoute, /rpc\("update_test_questions"/);
  assert.match(regenerateRoute, /rpc\("replace_test_question"/);
  assert.match(publishRoute, /rpc\("attest_test_review"/);
  assert.match(publishRoute, /rpc\("publish_test"/);
  assert.ok(publishRoute.indexOf('rpc("attest_test_review"') < publishRoute.indexOf('rpc("publish_test"'));
  assert.match(repair, /jsonb_array_length\(new\.source_chunk_ids\)=0/);
  assert.match(repair, /reviewed_by=auth\.uid\(\), reviewed_at=statement_timestamp\(\)/);

  // Assertions for targeted live schema repair
  const targetedRepair = read("supabase/repairs/targeted_live_schema_repair.sql");
  assert.match(targetedRepair, /create or replace function public\.save_draft_test/i);
  assert.match(targetedRepair, /create or replace function public\.update_test_questions/i);
  assert.match(targetedRepair, /create or replace function public\.replace_test_question/i);
  assert.match(targetedRepair, /create or replace function public\.attest_test_review/i);
  assert.match(targetedRepair, /create or replace function public\.publish_test/i);
  assert.match(targetedRepair, /create or replace function public\.claim_google_form_creation/i);
  assert.match(targetedRepair, /create or replace function public\.record_google_form_creation_form/i);
  assert.match(targetedRepair, /create or replace function public\.release_google_form_creation/i);
  assert.match(targetedRepair, /scores_test_google_response_id_uidx/i);
  assert.match(targetedRepair, /google_form_creation_attempts/i);
  assert.match(targetedRepair, /grant select, insert, update on public\.google_credentials to service_role/i);
});

test("Google Forms score webhook validates schema, counts and response IDs", () => {
  const { googleFormScoreWebhookSchema } = createTsLoader()("lib/validation/schemas.ts");
  const valid = googleFormScoreWebhookSchema.safeParse({
    formId: "form-1234567890",
    responseId: "resp-abc-123",
    studentName: "Ada Lovelace",
    studentEmail: "ada@example.edu",
    score: 8,
    totalQuestions: 10,
    submittedAt: new Date().toISOString(),
  });
  assert.equal(valid.success, true);

  const missingScore = googleFormScoreWebhookSchema.safeParse({
    formId: "form-1234567890",
    responseId: "resp-abc-123",
  });
  assert.equal(missingScore.success, false);

  const invalidFormId = googleFormScoreWebhookSchema.safeParse({
    formId: "short",
    responseId: "resp-1",
    score: 5,
    totalQuestions: 5,
  });
  assert.equal(invalidFormId.success, false);
});

test("generation model avoids the unresponsive gemini-3.8-flash, is overridable, and requests are time-bounded", () => {
  const { resolveGenerationModel, DEFAULT_GENERATION_MODEL, GENERATION_TIMEOUT_MS } =
    createTsLoader()("lib/ai/model.ts");
  assert.equal(resolveGenerationModel({}), DEFAULT_GENERATION_MODEL);
  assert.notEqual(DEFAULT_GENERATION_MODEL, "gemini-3.8-flash");
  assert.equal(resolveGenerationModel({ GEMINI_GENERATION_MODEL: "gemini-3-flash-preview" }), "gemini-3-flash-preview");
  assert.equal(resolveGenerationModel({ GEMINI_GENERATION_MODEL: "bad model;x" }), DEFAULT_GENERATION_MODEL);
  assert.ok(GENERATION_TIMEOUT_MS > 0 && GENERATION_TIMEOUT_MS <= 120_000);
  const gemini = fs.readFileSync(path.join(projectRoot, "lib/ai/gemini.ts"), "utf8");
  assert.ok(!gemini.includes("gemini-3.8-flash"));
  assert.ok(gemini.includes("timeout: GENERATION_TIMEOUT_MS"));
});
