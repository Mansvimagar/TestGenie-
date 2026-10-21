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
