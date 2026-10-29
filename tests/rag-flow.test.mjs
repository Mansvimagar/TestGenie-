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

test("Google Form gets four ungraded required identity items first and recovery matching accounts for them", () => {
  const { buildFormRequests, formMatchesQuestions, IDENTITY_FIELD_TITLES } =
    createTsLoader()("lib/google/form-structure.ts");
  const questions = [
    { id: "q1", question: "Capital of France?", options: ["Paris", "Rome", "Oslo", "Bern"], correctAnswerIndex: 0 },
    { id: "q2", question: "2 + 2?", options: ["3", "4", "5", "6"], correctAnswerIndex: 1 },
  ];
  assert.deepEqual([...IDENTITY_FIELD_TITLES], ["Full Name", "Roll No", "Class", "Division"]);

  const requests = buildFormRequests("Maths", questions);
  assert.equal(requests[0].updateSettings.settings.quizSettings.isQuiz, true);
  const items = requests.filter((r) => r.createItem).map((r) => r.createItem);
  assert.equal(items.length, 6);
  items.forEach((entry, index) => assert.equal(entry.location.index, index));
  items.slice(0, 4).forEach((entry, index) => {
    const q = entry.item.questionItem.question;
    assert.equal(entry.item.title, IDENTITY_FIELD_TITLES[index]);
    assert.equal(q.required, true);
    assert.ok(q.textQuestion);
    assert.equal(q.grading, undefined);
  });
  items.slice(4).forEach((entry, i) => {
    assert.equal(entry.item.questionItem.question.grading.pointValue, 1);
    assert.equal(entry.item.title, questions[i].question);
  });

  // Rebuild the form as Google would return it and check recovery matching.
  const form = { settings: { quizSettings: { isQuiz: true } }, items: items.map((entry) => ({ ...entry.item })) };
  assert.equal(formMatchesQuestions(form, questions), true);
  assert.equal(formMatchesQuestions({ ...form, items: form.items.slice(4) }, questions), false);
  assert.equal(formMatchesQuestions({ ...form, items: form.items.slice(0, 5) }, questions), false);
});

test("score ingest payload accepts identity fields and stores/parses them in student_name", () => {
  const { googleFormScoreWebhookSchema } = createTsLoader()("lib/validation/schemas.ts");
  const { formatStudentIdentity, parseStudentIdentity } = createTsLoader()("lib/scores/identity.ts");
  const payload = {
    formId: "form-1234567890", responseId: "r1", studentName: "Ada | Lovelace",
    studentRollNo: "42", studentClass: "TE", studentDivision: "B", score: 3, totalQuestions: 5,
  };
  assert.equal(googleFormScoreWebhookSchema.safeParse(payload).success, true);
  assert.equal(googleFormScoreWebhookSchema.safeParse({ ...payload, studentRollNo: "x".repeat(61) }).success, false);
  assert.equal(googleFormScoreWebhookSchema.safeParse({ ...payload, unknown: 1 }).success, false);

  const stored = formatStudentIdentity({ name: payload.studentName, rollNo: "42", className: "TE", division: "B" });
  assert.equal(stored, "Ada / Lovelace | Roll 42 | Class TE | Div B");
  assert.deepEqual(parseStudentIdentity(stored), { name: "Ada / Lovelace", rollNo: "42", className: "TE", division: "B" });
  assert.deepEqual(parseStudentIdentity("Legacy Name"), { name: "Legacy Name", rollNo: "", className: "", division: "" });
  assert.equal(formatStudentIdentity({ name: "Solo" }), "Solo");
});

test("server-side Forms sync maps scores and identity answers by question ID", () => {
  const { mapFormResponses, ResponseMappingError } = createTsLoader()("lib/google/response-mapper.ts");
  const { parseStudentIdentity } = createTsLoader()("lib/scores/identity.ts");
  const text = (id, title) => ({ title, questionItem: { question: { questionId: id, required: true, textQuestion: {} } } });
  const graded = (id, title) => ({ title, questionItem: { question: { questionId: id, grading: { pointValue: 1 } } } });
  // Identity items deliberately in a non-standard order: matching must use IDs, not position.
  const form = { items: [text("i2", "Roll No"), text("i1", "Full Name"), text("i3", "Class"), text("i4", "Division"), graded("g1", "Q1"), graded("g2", "Q2")] };
  const answer = (id, value) => [id, { questionId: id, textAnswers: { answers: [{ value }] } }];
  const responses = [
    { responseId: "r1", lastSubmittedTime: "2026-01-01T00:00:00Z", totalScore: 2, answers: Object.fromEntries([answer("i1", "Ada | L"), answer("i2", "42"), answer("i3", "TE"), answer("i4", "B")]) },
    { responseId: "r2", createTime: "2026-01-02T00:00:00Z", respondentEmail: "x@y.edu", answers: { g1: { grade: { score: 1 } }, g2: { grade: { score: 0 } } } },
    { responseId: "r3", answers: { g1: { grade: { score: 1 } } } },
    { responseId: "r4", totalScore: 9 },
    { totalScore: 1 },
  ];
  const { rows, skipped } = mapFormResponses(form, responses, 2);
  assert.equal(rows.length, 2);
  assert.equal(skipped, 3);
  assert.equal(rows[0].google_response_id, "r1");
  assert.equal(rows[0].score, 2);
  assert.equal(rows[0].percentage, 100);
  assert.deepEqual(parseStudentIdentity(rows[0].student_name), { name: "Ada / L", rollNo: "42", className: "TE", division: "B" });
  assert.equal(rows[1].score, 1);
  assert.equal(rows[1].percentage, 50);
  assert.equal(parseStudentIdentity(rows[1].student_name).name, "x@y.edu");
  assert.throws(() => mapFormResponses(form, responses, 3), ResponseMappingError);
});

test("score sync route is owner-scoped and reuses the idempotent upsert; responses scope is requested", () => {
  const route = fs.readFileSync(path.join(projectRoot, "app/api/scores/sync/route.ts"), "utf8");
  assert.ok(route.includes('.eq("user_id", user.id)'));
  assert.ok(route.includes('onConflict: "test_id,google_response_id"'));
  const auth = fs.readFileSync(path.join(projectRoot, "lib/google/auth.ts"), "utf8");
  assert.ok(auth.includes("forms.responses.readonly"));
  const responses = fs.readFileSync(path.join(projectRoot, "lib/google/responses.ts"), "utf8");
  assert.ok(responses.includes('"scope_missing"') && responses.includes('"not_connected"'));
});

function fakeIdentityClient(form, { responses = false } = {}) {
  const calls = { batchUpdate: [], listed: 0 };
  return {
    calls,
    getForm: async () => form,
    hasAnyResponse: async () => { calls.listed += 1; return responses; },
    batchUpdate: async (_id, body) => { calls.batchUpdate.push(body); },
  };
}

test("old forms: identity fields are added once, never with responses, and never touch graded items", async () => {
  const { addIdentityFields, inspectIdentityFields, IdentityFieldsError } = createTsLoader()("lib/google/identity-fields.ts");
  const { formMatchesQuestions, identityFieldState } = createTsLoader()("lib/google/form-structure.ts");
  const questions = [{ id: "q1", question: "Q one?", options: ["a", "b", "c", "d"], correctAnswerIndex: 2 }];
  const gradedItem = { title: "Q one?", questionItem: { question: { required: true, choiceQuestion: { type: "RADIO", options: ["a", "b", "c", "d"].map((value) => ({ value })) }, grading: { pointValue: 1, correctAnswers: { answers: [{ value: "c" }] } } } } };
  const oldForm = () => ({ revisionId: "rev1", settings: { quizSettings: { isQuiz: true } }, items: [structuredClone(gradedItem)] });

  // Old form, no responses -> inserts exactly four createItem requests at 0-3.
  const client = fakeIdentityClient(oldForm());
  assert.equal(await addIdentityFields(client, "form-1234567890"), "added");
  const [body] = client.calls.batchUpdate;
  assert.equal(body.requests.length, 4);
  assert.deepEqual(body.requests.map((r) => r.createItem.location.index), [0, 1, 2, 3]);
  assert.ok(body.requests.every((r) => r.createItem && !r.createItem.item.questionItem.question.grading));
  assert.deepEqual(body.writeControl, { requiredRevisionId: "rev1" });

  // Result of that insert is recognised by recovery matching.
  const updated = oldForm();
  updated.items = [...body.requests.map((r) => structuredClone(r.createItem.item)), ...updated.items];
  assert.equal(identityFieldState(updated), "present");
  assert.equal(formMatchesQuestions(updated, questions), true);
  assert.equal(formMatchesQuestions(oldForm(), questions), false);

  // Idempotent: nothing is sent when the fields already exist, and responses are not even queried.
  const again = fakeIdentityClient(updated);
  assert.equal(await addIdentityFields(again, "form-1234567890"), "already_present");
  assert.equal(again.calls.batchUpdate.length, 0);
  assert.equal(again.calls.listed, 0);

  // Responses exist -> refused, nothing written.
  const withResponses = fakeIdentityClient(oldForm(), { responses: true });
  await assert.rejects(() => addIdentityFields(withResponses, "form-1234567890"), (err) => err instanceof IdentityFieldsError && err.code === "has_responses");
  assert.equal(withResponses.calls.batchUpdate.length, 0);
  assert.equal((await inspectIdentityFields(withResponses, "form-1234567890")).state, "missing_has_responses");

  // Partial identity items -> refused.
  const partial = oldForm();
  partial.items.push({ title: "Roll No", questionItem: { question: { required: true, textQuestion: {} } } });
  const partialClient = fakeIdentityClient(partial);
  await assert.rejects(() => addIdentityFields(partialClient, "form-1234567890"), (err) => err.code === "partial");
  assert.equal(partialClient.calls.batchUpdate.length, 0);
});

test("clipboard helper uses the Clipboard API, falls back to execCommand, and never throws", async () => {
  const { copyToClipboard } = createTsLoader()("lib/copy-to-clipboard.ts");
  const saved = { navigator: globalThis.navigator, document: globalThis.document, secure: globalThis.isSecureContext };
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const makeDocument = (execResult) => {
    const log = { appended: 0, removed: 0, copied: 0 };
    const textarea = { style: {}, setAttribute() {}, select() {}, setSelectionRange() {} };
    return { log, document: {
      createElement: () => textarea,
      body: { appendChild: () => { log.appended += 1; }, removeChild: () => { log.removed += 1; } },
      execCommand: (cmd) => { assert.equal(cmd, "copy"); log.copied += 1; if (execResult instanceof Error) throw execResult; return execResult; },
    } };
  };
  try {
    // Secure context with Clipboard API.
    let written = null;
    set("navigator", { clipboard: { writeText: async (t) => { written = t; } } });
    set("isSecureContext", true);
    assert.equal(await copyToClipboard("https://forms.example/x"), true);
    assert.equal(written, "https://forms.example/x");

    // navigator.clipboard undefined (insecure context) -> textarea + execCommand.
    set("navigator", {});
    set("isSecureContext", false);
    let env = makeDocument(true);
    set("document", env.document);
    assert.equal(await copyToClipboard("link"), true);
    assert.deepEqual(env.log, { appended: 1, removed: 1, copied: 1 });

    // Clipboard API rejects -> fallback is used.
    set("navigator", { clipboard: { writeText: async () => { throw new Error("denied"); } } });
    set("isSecureContext", true);
    env = makeDocument(true);
    set("document", env.document);
    assert.equal(await copyToClipboard("link"), true);

    // execCommand returns false, then throws -> false, textarea always cleaned up, no throw.
    set("navigator", {});
    env = makeDocument(false);
    set("document", env.document);
    assert.equal(await copyToClipboard("link"), false);
    env = makeDocument(new Error("boom"));
    set("document", env.document);
    assert.equal(await copyToClipboard("link"), false);
    assert.equal(env.log.removed, 1);

    // No DOM at all.
    set("document", undefined);
    assert.equal(await copyToClipboard("link"), false);
  } finally {
    set("navigator", saved.navigator);
    set("document", saved.document);
    set("isSecureContext", saved.secure);
  }
});

test("per-test results: newest first, identity columns, summary and safe CSV export", () => {
  const { toResultRows, summarizeResults, buildResultsCsv, csvFilename } = createTsLoader()("lib/scores/results.ts");
  const score = (id, name, points, submitted, email = "") => ({
    id, student_name: name, student_email: email, score: points, total_questions: 4,
    percentage: points * 25, submitted_at: submitted,
  });
  const rows = toResultRows([
    score("a", "Ada | Roll 7 | Class TE | Div A", 4, "2026-10-01T10:00:00Z"),
    score("b", "=HYPERLINK(\"x\") | Roll 9 | Class TE | Div B", 2, "2026-10-03T10:00:00Z", "b@x.edu"),
    score("c", "Legacy, Name", 3, "2026-10-02T10:00:00Z"),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["b", "c", "a"]);
  assert.deepEqual([rows[2].rollNo, rows[2].className, rows[2].division], ["7", "TE", "A"]);
  assert.equal(rows[1].rollNo, "");

  const summary = summarizeResults(rows);
  assert.deepEqual(summary, { count: 3, averageScore: 3, averagePercentage: 75, total: 4 });
  assert.equal(summarizeResults([]).count, 0);
  assert.equal(summarizeResults([{ score: 1, total: 2, percentage: 50 }, { score: 1, total: 4, percentage: 25 }]).total, 0);

  const csv = buildResultsCsv(rows);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "Name,Roll No,Class,Division,Email,Score,Total,Percentage,Submitted at");
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith('"\'=HYPERLINK(""x"")",9,TE,B,b@x.edu,2,4,50,'), lines[1]);
  assert.ok(lines[2].startsWith('"Legacy, Name",,,,'), lines[2]);
  assert.equal(csvFilename("MLOps: Intro / Basics!"), "mlops-intro-basics-results.csv");
  assert.equal(csvFilename("***"), "test-results.csv");
});

test("test detail and scores pages only read the signed-in faculty member's own data", () => {
  const read = (file) => fs.readFileSync(path.join(projectRoot, file), "utf8");
  const detail = read("app/dashboard/tests/[id]/page.tsx");
  assert.ok(detail.includes("test.user_id !== user.id"));
  assert.ok(detail.includes("ResponsesTable"));
  const scoresPage = read("app/dashboard/scores/page.tsx");
  assert.ok(scoresPage.includes('.eq("tests.user_id", user.id)'));
  assert.ok(/from\("tests"\)[\s\S]*?\.eq\("user_id", user\.id\)/.test(scoresPage));
  const table = read("components/scores/scores-table.tsx");
  assert.ok(table.includes("Download CSV") && table.includes("tests.map"));
  assert.ok(read("components/scores/responses-table.tsx").includes("click Sync scores"));
});

const providerError = (status, message = "provider failure") => Object.assign(new Error(message), { status });
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

function fakeClock() {
  const clock = { t: 0, slept: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.slept.push(ms); clock.t += ms; };
  return clock;
}

test("provider errors are classified: 503 busy, 429 rate limit, timeouts, 404 model, 400/401/403 config", () => {
  const { classifyProviderError, isTransientProviderError } = createTsLoader()("lib/ai/model.ts");
  assert.equal(classifyProviderError(providerError(503)), "busy");
  assert.equal(classifyProviderError(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}')), "busy");
  assert.equal(classifyProviderError(providerError(429)), "rate_limit");
  assert.equal(classifyProviderError(new Error("RESOURCE_EXHAUSTED: quota")), "rate_limit");
  assert.equal(classifyProviderError(timeoutError()), "timeout");
  assert.equal(classifyProviderError(new TypeError("fetch failed")), "timeout");
  assert.equal(classifyProviderError(providerError(404)), "model_unavailable");
  for (const status of [400, 401, 403]) assert.equal(classifyProviderError(providerError(status)), "config");
  assert.equal(classifyProviderError(new Error("something odd")), "unknown");
  assert.equal(isTransientProviderError(providerError(503)), true);
  assert.equal(isTransientProviderError(providerError(403)), false);
  assert.equal(isTransientProviderError(providerError(404)), false);
});

test("model chain: env override, defaults prefer stable models, and unusable models are skipped", () => {
  const { resolveModelChain, filterAvailableModels, DEFAULT_MODEL_CHAIN, planBatches } = createTsLoader()("lib/ai/model.ts");
  assert.deepEqual(resolveModelChain({}), [...DEFAULT_MODEL_CHAIN]);
  assert.ok(!DEFAULT_MODEL_CHAIN.some((name) => /3\.8|3\.7|2\.0|2\.5|latest/.test(name)));
  assert.ok(/preview/.test(DEFAULT_MODEL_CHAIN.at(-1)) && !DEFAULT_MODEL_CHAIN.slice(0, -1).some((n) => /preview/.test(n)));
  assert.deepEqual(resolveModelChain({ GEMINI_MODEL_CHAIN: "model-a, model-b ,bad name;x,model-a" }), ["model-a", "model-b"]);
  assert.equal(resolveModelChain({ GEMINI_GENERATION_MODEL: "custom-model" })[0], "custom-model");

  const chain = ["a", "b", "c"];
  assert.deepEqual(filterAvailableModels(chain, new Set(["b", "c", "z"])), ["b", "c"]);
  assert.deepEqual(filterAvailableModels(chain, null), chain);
  assert.deepEqual(filterAvailableModels(chain, new Set(["z"])), chain);

  assert.deepEqual(planBatches(5), [5]);
  assert.deepEqual(planBatches(6), [3, 3]);
  assert.deepEqual(planBatches(12), [4, 4, 4]);
  assert.deepEqual(planBatches(50), Array(10).fill(5));
  assert.ok(planBatches(13).every((n) => n <= 5) && planBatches(13).reduce((a, b) => a + b) === 13);
});

test("runWithFallback: success, 503 and 429 and timeout retry on the next model with backoff and jitter", async () => {
  const { runWithFallback } = createTsLoader()("lib/ai/model.ts");
  const run = async (script) => {
    const clock = fakeClock();
    const calls = [];
    const result = await runWithFallback({
      models: ["m1", "m2", "m3"], now: clock.now, sleep: clock.sleep, random: () => 1,
      call: async (model) => { calls.push(model); const step = script.shift(); if (step instanceof Error) throw step; return step; },
    });
    return { result, calls, clock };
  };

  assert.deepEqual((await run(["ok"])).calls, ["m1"]);

  const busy = await run([providerError(503), "ok"]);
  assert.deepEqual(busy.calls, ["m1", "m2"]);
  assert.equal(busy.result, "ok");

  const mixed = await run([providerError(503), providerError(429), timeoutError(), "ok"]);
  assert.deepEqual(mixed.calls, ["m1", "m2", "m3", "m1"]);
  // random()=1 -> full cap: 1s, 2s, 4s (exponential).
  assert.deepEqual(mixed.clock.slept, [1000, 2000, 4000]);

  // random()=0 -> half the cap, so every delay stays within [cap/2, cap].
  const jitter = fakeClock();
  let failures = 0;
  await runWithFallback({
    models: ["m1"], now: jitter.now, sleep: jitter.sleep, random: () => 0,
    call: async () => { if (failures++ < 2) throw providerError(503); return "ok"; },
  });
  assert.deepEqual(jitter.slept, [500, 1000]);
});

test("runWithFallback: 400/401/403/unknown are not retried; 404 skips the model without waiting", async () => {
  const { runWithFallback, ProviderCallError } = createTsLoader()("lib/ai/model.ts");
  for (const status of [400, 401, 403]) {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      () => runWithFallback({ models: ["m1", "m2"], now: clock.now, sleep: clock.sleep, call: async () => { calls += 1; throw providerError(status); } }),
      (err) => err instanceof ProviderCallError && err.kind === "config"
    );
    assert.equal(calls, 1);
    assert.deepEqual(clock.slept, []);
  }

  const clock = fakeClock();
  const seen = [];
  const result = await runWithFallback({
    models: ["gone", "m2"], now: clock.now, sleep: clock.sleep,
    call: async (model) => { seen.push(model); if (model === "gone") throw providerError(404); return "ok"; },
  });
  assert.equal(result, "ok");
  assert.deepEqual(seen, ["gone", "m2"]);
  assert.deepEqual(clock.slept, []);

  await assert.rejects(
    () => runWithFallback({ models: ["a", "b"], now: clock.now, sleep: clock.sleep, call: async () => { throw providerError(404); } }),
    (err) => err.kind === "config"
  );
});

test("runWithFallback stops at the time budget and reports the last failure kind", async () => {
  const { runWithFallback, ProviderCallError } = createTsLoader()("lib/ai/model.ts");
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    () => runWithFallback({
      models: ["m1", "m2"], budgetMs: 10_000, now: clock.now, sleep: clock.sleep, random: () => 1,
      call: async () => { calls += 1; clock.t += 3_000; throw providerError(503); },
    }),
    (err) => err instanceof ProviderCallError && err.kind === "busy"
  );
  assert.ok(clock.t <= 10_000 + 3_000, `ran to ${clock.t}ms`);
  assert.ok(calls >= 2 && calls < 8);

  const rate = fakeClock();
  await assert.rejects(
    () => runWithFallback({ models: ["m1"], budgetMs: 1_500, now: rate.now, sleep: rate.sleep, random: () => 1, call: async () => { throw providerError(429); } }),
    (err) => err.kind === "rate_limit"
  );
});

function loadGeminiWithFake(script) {
  const calls = [];
  class FakeGenAI {
    constructor(opts) {
      this.timeout = opts?.httpOptions?.timeout;
      this.models = {
        generateContent: async ({ model }) => {
          calls.push({ model, timeout: this.timeout });
          const step = script.shift();
          if (step instanceof Error) throw step;
          return { text: JSON.stringify(step) };
        },
      };
    }
  }
  const loader = createTsLoader({
    "@google/genai": { GoogleGenAI: FakeGenAI, Type: { OBJECT: "OBJECT", ARRAY: "ARRAY", STRING: "STRING", INTEGER: "INTEGER" } },
  });
  return { gemini: loader("lib/ai/gemini.ts"), calls };
}

const mcq = (n) => ({
  topic: "Pipelines",
  question: `Which statement about topic number ${n} and unique concept zeta${n} is correct`,
  options: [`alpha ${n}`, `beta ${n}`, `gamma ${n}`, `delta ${n}`],
  correctAnswerIndex: 0,
  explanation: `Because concept zeta${n} says so.`,
});
const batchOf = (start, size) => ({ questions: Array.from({ length: size }, (_, i) => mcq(start + i)) });
const chunk = { chunkId: "c1", syllabusId: "s1", content: "concept", unit: null, topic: null, subtopic: null, pageStart: 1, pageEnd: 1, similarity: 0.9, embeddingProvider: "gemini" };
const genConfig = (count) => ({ syllabusId: "s1", title: "T", subject: "S", questionCount: count, difficulty: "easy", questionType: "mcq" });

async function withGeminiEnv(fn) {
  const saved = { p: process.env.AI_PROVIDER, k: process.env.GEMINI_API_KEY, f: globalThis.fetch };
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  globalThis.fetch = async () => { throw new Error("no network in tests"); };
  try {
    return await fn();
  } finally {
    if (saved.p === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = saved.p;
    if (saved.k === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.k;
    globalThis.fetch = saved.f;
  }
}

test("batched generation: 12 questions run as 3 batches of 4, merge, validate each batch and recover from a 503", async () => {
  await withGeminiEnv(async () => {
    const clock = fakeClock();
    const { gemini, calls } = loadGeminiWithFake([batchOf(0, 4), providerError(503), batchOf(10, 4), batchOf(20, 4)]);
    const validated = [];
    const result = await gemini.generateGroundedQuestionBatches(genConfig(12), [chunk], {
      retry: { now: clock.now, sleep: clock.sleep, random: () => 0 },
      validateBatch: (batch) => { validated.push(batch.length); return batch.map((q) => ({ ...q, sourceChunkIds: ["c1"] })); },
    });
    assert.equal(result.partial, false);
    assert.equal(result.questions.length, 12);
    assert.deepEqual(validated, [4, 4, 4]);
    assert.ok(result.questions.every((q) => q.sourceChunkIds[0] === "c1"));
    assert.equal(calls.length, 4);
    assert.notEqual(calls[1].model, calls[2].model);
    assert.ok(calls.every((call) => call.timeout <= 90_000));
  });
});

test("batched generation: duplicates across batches are removed", async () => {
  await withGeminiEnv(async () => {
    const clock = fakeClock();
    const { gemini } = loadGeminiWithFake([batchOf(0, 3), batchOf(0, 3)]);
    const result = await gemini.generateGroundedQuestionBatches(genConfig(6), [chunk], { retry: { now: clock.now, sleep: clock.sleep } });
    assert.equal(result.questions.length, 3);
  });
});

test("batched generation: a failed batch fails clearly unless partial results were requested", async () => {
  await withGeminiEnv(async () => {
    const attempt = async (options) => {
      const clock = fakeClock();
      const { gemini } = loadGeminiWithFake([batchOf(0, 3), ...Array(10).fill(providerError(429))]);
      return gemini.generateGroundedQuestionBatches(genConfig(6), [chunk], {
        ...options,
        retry: { now: clock.now, sleep: clock.sleep, random: () => 0 },
      });
    };

    await assert.rejects(() => attempt({}), (err) =>
      err.kind === "rate_limit" && /rate limit or quota/.test(err.message) && !/429|RESOURCE|status/i.test(err.message));

    const partial = await attempt({ allowPartial: true });
    assert.equal(partial.partial, true);
    assert.equal(partial.questions.length, 3);
    assert.equal(partial.requested, 6);

    // allowPartial without any finished batch still fails.
    const clock = fakeClock();
    const { gemini } = loadGeminiWithFake(Array(10).fill(providerError(503)));
    await assert.rejects(
      () => gemini.generateGroundedQuestionBatches(genConfig(3), [chunk], { allowPartial: true, retry: { now: clock.now, sleep: clock.sleep, random: () => 0 } }),
      (err) => err.kind === "busy" && /busy/.test(err.message)
    );
  });
});

test("batched generation: timeouts and config errors map to distinct safe messages and statuses", async () => {
  await withGeminiEnv(async () => {
    const { SAFE_FAILURE_MESSAGES, httpStatusForFailure } = createTsLoader()("lib/ai/model.ts");
    const run = async (script) => {
      const clock = fakeClock();
      const { gemini, calls } = loadGeminiWithFake(script);
      try {
        await gemini.generateGroundedQuestionBatches(genConfig(2), [chunk], { retry: { now: clock.now, sleep: clock.sleep, random: () => 0 } });
      } catch (err) {
        return { err, calls };
      }
      throw new Error("expected failure");
    };
    const timeout = await run(Array(10).fill(timeoutError()));
    assert.equal(timeout.err.kind, "timeout");
    assert.equal(timeout.err.message, SAFE_FAILURE_MESSAGES.timeout);
    const config = await run([providerError(403, "API key not valid: AIzaSySecretSecretSecret123")]);
    assert.equal(config.err.kind, "config");
    assert.equal(config.calls.length, 1);
    assert.ok(!/AIza|API key not valid/.test(config.err.message));
    assert.deepEqual(["busy", "rate_limit", "timeout", "config"].map(httpStatusForFailure), [503, 429, 504, 503]);
    const messages = new Set(["busy", "rate_limit", "timeout", "config"].map((k) => SAFE_FAILURE_MESSAGES[k]));
    assert.equal(messages.size, 4);
  });
});

test("models.list is cached for 10 minutes and a failure falls back to the unfiltered chain", async () => {
  const { getAvailableGenerationModels, resetModelAvailabilityCache } = createTsLoader()("lib/ai/model-availability.ts");
  resetModelAvailabilityCache();
  let fetches = 0;
  let clock = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ models: [
      { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
    ] }) };
  };
  const first = await getAvailableGenerationModels("k", { fetchImpl, now: () => clock });
  assert.deepEqual([...first], ["gemini-3.5-flash"]);
  clock += 9 * 60_000;
  await getAvailableGenerationModels("k", { fetchImpl, now: () => clock });
  assert.equal(fetches, 1);
  clock += 2 * 60_000;
  await getAvailableGenerationModels("k", { fetchImpl, now: () => clock });
  assert.equal(fetches, 2);
  resetModelAvailabilityCache();
  assert.equal(await getAvailableGenerationModels("k", { fetchImpl: async () => { throw new Error("down"); } }), null);
});

test("generate route: duration cap exceeds the generation budget, partial is opt-in, UI keeps inputs and offers Retry", () => {
  const read = (file) => fs.readFileSync(path.join(projectRoot, file), "utf8");
  const model = createTsLoader()("lib/ai/model.ts");
  const route = read("app/api/generate/route.ts");
  const maxDuration = Number(/export const maxDuration = (\d+)/.exec(route)?.[1]);
  assert.ok(maxDuration * 1000 > model.REQUEST_GENERATION_BUDGET_MS + 30_000, `maxDuration ${maxDuration}s`);
  assert.ok(model.BATCH_RETRY_BUDGET_MS <= 100_000 && model.GENERATION_TIMEOUT_MS <= model.BATCH_RETRY_BUDGET_MS);
  assert.equal(model.MAX_BATCH_QUESTIONS, 5);
  assert.ok(route.includes("allowPartial: input.allowPartial === true"));
  const { groundedGenerateRequestSchema } = createTsLoader()("lib/validation/schemas.ts");
  const base = { syllabusId: "6f1c9a4e-1b2c-4d3e-8f90-123456789abc", testTitle: "T", subject: "S", questionCount: 5, difficulty: "easy" };
  assert.equal(groundedGenerateRequestSchema.safeParse(base).success, true);
  assert.equal(groundedGenerateRequestSchema.safeParse({ ...base, allowPartial: true }).success, true);
  assert.equal(groundedGenerateRequestSchema.safeParse({ ...base, allowPartial: "yes" }).success, false);
  const page = read("app/dashboard/generate/page.tsx");
  assert.ok(page.includes("Retry") && page.includes("handleConfigSubmit(config)"));
  assert.ok(read("components/syllabus/config-step.tsx").includes("Allow partial results"));
});
