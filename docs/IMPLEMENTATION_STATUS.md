# TestGenie implementation status

Audit date: 2026-10-22  
Repository: `D:\Third_Year\DTPLM\Testgiene\testgenie-mvp-plus-rag-partial`  
Branch: `master` at `d9ea04f` (`chore: checkpoint TestGenie before completion modules`)

This is a source and artifact audit, not a live service verification. A route,
migration, or helper in the repository shows intended local behavior; it does
not prove that the app has been exercised successfully or that the corresponding
schema is installed in Supabase.

## Repository state and audit boundary

The worktree is already dirty. It contains modified test, Google OAuth/Form,
and response handling code, as well as untracked backup, migration, script,
and repair artifacts. No existing change was discarded during this audit. The
closure review preserved the existing dirty worktree and made documentation
and environment-example updates only. Local lint, the existing unit suite,
TypeScript checking, and a production build were run; no SQL was connected to
or run against Supabase, and no deployment was performed.

There is one recent commit in the inspected history: `d9ea04f`. Package scripts
are `dev`, `build`, `start`, `lint`, `test` (`node --test tests/rag-flow.test.mjs`),
and `zip`. `.env.example` names Supabase URL/anon/service-role values, Gemini
configuration, Google OAuth client configuration, and the app URL. A local
`.env.local` exists; its contents were not inspected or copied into this report.

## Module status

| Module | Status | Evidence and limits |
|---|---|---|
| Faculty authentication and authorization | Implemented locally; needs runtime verification | `middleware.ts`, `lib/supabase/middleware.ts`, `lib/supabase/server.ts`, `app/(auth)/login/page.tsx`, `app/(auth)/signup/page.tsx`, and `app/dashboard/layout.tsx` use Supabase Auth sessions and protect dashboard pages. API routes call `auth.getUser()`. Database ownership relies on RLS migrations. No real sign-in/RLS cross-user test was run in this audit. |
| Syllabus upload and extraction | Implemented locally; needs runtime verification | `app/api/syllabus/route.ts` supports authenticated PDF and manual text input; limits PDF size to 15 MB and manual text to 500,000 characters. `lib/pdf/parser.ts` extracts text; scanned/image-only PDF OCR is not evidenced. `lib/syllabus/ingest.ts` creates a processing syllabus, chunks and embeds it, stores chunks, and marks it ready/error. Page boundaries are intentionally not retained by current extraction, so chunk page fields are not populated. |
| Chunking, embeddings, retrieval/RAG | Implemented locally; live RPC/schema needs verification | `lib/pdf/structure.ts`, `lib/pdf/chunking.ts`, `lib/embeddings/index.ts`, `lib/rag/retrieval.ts`, and `lib/rag/scope.ts` implement structure/chunking, embeddings, scoped vector retrieval and local scope checks. Retrieval calls `match_syllabus_chunks` with five named parameters. The SQL definition is in `supabase/migrations/002_syllabus_knowledge_base.sql`. Real vector dimensions, extension installation, function grants, and live results have not been verified. |
| AI generation and validation | Implemented locally; provider path needs runtime verification | `app/api/generate/route.ts`, `lib/ai/gemini.ts`, `lib/ai/grounded-response.ts`, `lib/ai/schema.ts`, and `lib/validation/{schemas,question-quality}.ts` validate model output, attach retrieved provenance, check quality, and review support. The route refuses mock mode for syllabus-grounded generation and refuses non-Gemini embedding provenance. No live Gemini request was made. |
| Question review/editing | Partially implemented; database alignment needs verification | `components/questions/question-editor.tsx`, `components/questions/question-card.tsx`, and `components/tests/test-detail-view.tsx` provide edit/review UI. `app/api/tests/[id]/route.ts` calls `update_test_questions`; regeneration route calls `replace_test_question`. The local migration set defines atomic edit behavior, but `replace_test_question` is not found among migrations 001–011; the v2 repair candidate includes it. Live RPC availability is unknown. |
| Draft save and publication | Partially implemented; production database is a blocker | `app/api/tests/route.ts` calls `save_draft_test`. `app/api/tests/[id]/publish/route.ts` records `attest_test_review` then calls `publish_test`. Definitions appear in migrations 006–011 (notably 006/007/008/009/010/011), with newer workflow logic proposed in `supabase/repairs/reconcile_test_workflow_v2.sql`. The repository’s repair artifacts describe review columns/functions/grants that need live comparison. None of these SQL files was executed or verified against the intended project. |
| Google OAuth | Implemented locally; credentials and callback configuration required | `app/api/google/connect/route.ts`, `app/api/google/callback/route.ts`, and `lib/google/auth.ts` implement consent, callback, token exchange/storage and refresh. Credentials use a server-side service-role Supabase client. Current worktree adds a nonce cookie check. Needs configured OAuth credentials, redirect URIs, enabled APIs, database access posture, and a real round-trip check; not verified here. |
| Google Forms creation | Partially implemented; external/API and recovery paths need verification | `app/api/forms/route.ts`, `lib/google/forms.ts`, `components/forms/create-form-button.tsx`, and `components/tests/test-detail-view.tsx` create a quiz, attach correct answers, persist its reference and display it. Current worktree adds form-ID recovery/reuse after some partial failures. Google Forms API behavior and retry/concurrent-request behavior were not exercised. README notes email collection and grade-release settings require manual Forms UI configuration. |
| Score ingestion and dashboard | Implemented locally; external setup and live verification required | Dashboard/API readers are `app/dashboard/scores/page.tsx`, `components/scores/scores-table.tsx`, and `app/api/scores/route.ts`; the base `scores` table/policy is in migration 001. The worktree adds `app/api/scores/ingest/route.ts`, `scripts/google-forms-score-sync.gs`, and migration 012 for authenticated webhook ingestion and response-ID idempotency. Migration 012 is not confirmed applied; `GOOGLE_FORMS_WEBHOOK_SECRET` and per-form Apps Script properties/trigger are required. No graded response was ingested. |
| Database preflight/repair | Prepared locally; live audit and administrator review remain | `supabase/repairs/preflight_test_workflow_v2.sql` is labeled read-only and collects catalog metadata; it has not been run. `supabase/repairs/reconcile_test_workflow_v2.sql` is explicitly marked NOT FOR EXECUTION. `supabase/repairs/reconcile_test_workflow.sql`, `supabase/repairs/google_credentials_access_hotfix.sql`, and `supabase/repairs/README.md` are also local review artifacts. No connection, SQL execution, migration-ledger reconciliation, backup validation, or live project-ref verification occurred. |

## RPC map

| RPC | Caller | Definition evidence | Audit finding |
|---|---|---|---|
| `match_syllabus_chunks` | `lib/rag/retrieval.ts` | `supabase/migrations/002_syllabus_knowledge_base.sql` | Five named inputs are expected; confirm actual argument names/types, vector dimensions, and execute grants from live preflight. |
| `save_draft_test` | `app/api/tests/route.ts` | Migrations 006, 007, 008, 010; repair candidate v2 | Caller sends syllabus ID, generation config, and question JSON. Live definition may differ from local latest source. |
| `update_test_questions` | `app/api/tests/[id]/route.ts` | Migrations 008 and 010; repair candidate | This is the edit RPC name in current caller. `update_draft_test` is not found as a caller or definition in inspected `app`, `lib`, and migration files. |
| `replace_test_question` | `app/api/tests/[id]/questions/[questionId]/regenerate/route.ts` | Repair candidate v2 only among inspected migration 001–011 files | Required by current regeneration caller, but no definition appears in the inspected migration history. Live presence is unknown. |
| `attest_test_review` | `app/api/tests/[id]/publish/route.ts` | Repair candidate v2; not found in migrations 001–011 | Caller invokes it before publication. Live presence is unknown. |
| `publish_test` | `app/api/tests/[id]/publish/route.ts` | `supabase/migrations/009_publish_reviewed_tests.sql`, modified in 011; repair candidate v2 | Caller passes `p_test_id`. Confirm actual signature, ownership, security mode, RLS interaction, and grants live. |

`update_draft_test` is not the current code interface. Avoid introducing that name
unless the app and database contract are intentionally changed together.

### Chunk 1 reconciliation (2026-10-22)

| RPC | Local migration contract | Application contract | V2 repair candidate |
|---|---|---|---|
| `match_syllabus_chunks` | Migration 002: `query_embedding vector(768), match_syllabus_id uuid, match_unit text, match_topic text, match_count integer`; returns chunk ID/scope/content/pages/index/metadata/similarity; stable invoker. | `lib/rag/retrieval.ts` passes the same five named inputs and reads matching output fields. | Preflight checks input types, arg/output names and invoker mode; repair requires `vector(768)`. Live extension/type/data remain unverified. **Matched locally.** |
| `save_draft_test` | Migrations 006–008 and 010: `(p_syllabus_id uuid, p_generation_config jsonb, p_questions jsonb) returns jsonb`; auth, owner and ready-syllabus checks; atomic insert. | `app/api/tests/route.ts` sends the same names and question fields. | Same signature/return; adds stricter payload, option, explanation and source checks; definer with fixed path and explicit `auth.uid()` ownership binding. **Matched by signature; candidate strengthens behavior.** |
| `update_test_questions` | Migrations 008/010: `(p_test_id uuid, p_title text, p_subject text, p_difficulty text, p_questions jsonb) returns void`; migration 010 locks and checks an owned draft then atomically replaces questions. | `app/api/tests/[id]/route.ts` sends the same names and JSON field shape. | Same signature/return; definer with fixed path plus auth/owner/draft/syllabus checks, allowing narrowed direct table ACLs. **Matched.** |
| `replace_test_question` | No definition in migrations 001–011. Migration 010 mentions regeneration in comments but does not define this RPC. | Regeneration route sends `(p_test_id, p_question_id, p_question)` and expects a single-question replacement. | Defines `(uuid, uuid, jsonb) returns void`, validates payload, owner and draft before replacing one row. **Missing from migration-only setup; candidate matches caller.** |
| `attest_test_review` | No definition in migrations 001–011. | Publish route sends `(p_test_id)` then invokes `publish_test`. | Defines `(uuid) returns void`, checks authenticated owner/draft, runs the publication gate and records reviewer/timestamp. **Missing from migration-only setup; candidate matches caller.** |
| `publish_test` | Migrations 009/011: `(p_test_id uuid) returns void`; definer, authenticated owner/draft check; 009 checks question count/content and 011 fixes path/owner requirements. | Publish route passes `p_test_id`, after attestation. | Same interface; requires persisted attestation and validates source scope at publication. **Matched by signature; candidate strengthens behavior.** |

The v2 preflight's executable statements are `SELECT` or `WITH ... SELECT`
queries over catalogs/settings/privilege predicates. It does not invoke
application RPCs, read credential rows, or mutate schema/data. It reports
vector extension/type/typmod and locates `vector_dims`; for an unconstrained
vector column, actual stored dimensions need a separate read-only
`vector_dims(embedding)` query. It reports SQL session identity, but project ref
still needs manual confirmation against the Supabase Dashboard.

Source review shows the v2 repair RPC interfaces and grants align with callers.
Its definer save/edit/replacement routines have explicit `auth.uid()` and owner
checks, fixed search paths, and are paired with draft/provenance triggers. Its
ACLs remove direct authenticated question writes and permit the RPC paths;
published test updates remain limited to Google Form reference columns. These
are code-review findings only. The candidate is not executed and says nothing
about the intended live database.

## Confirmed gaps and unverified connections

- The repository does not establish which migration files are installed in the
  intended Supabase project. The v2 preflight should be run only in the
  SQL Editor after independently confirming the project in the Dashboard.
- Current regeneration calls `replace_test_question`, while that RPC is not
  defined in migration files 001–011. This is a confirmed local migration
  coverage gap; whether the live database already has the function is unknown.
- Current publish route calls `attest_test_review`; that function is proposed
  in the repair candidate but is not found in migrations 001–011. Live presence
  is unknown.
- In the migration-only definitions, `validate_question_provenance()` accepts
  an empty `source_chunk_ids` array and the migration 009 publish gate does not
  require source provenance. The app route checks sources, but direct
  authenticated RPC invocation can bypass route-level validation. This is a
  confirmed local database-contract gap. The v2 candidate requires non-empty,
  in-scope Gemini source IDs on writes and rechecks them at publication.
- Migration 010's restrictive test insert policy checks owner and draft status,
  but not that `syllabus_id` belongs to that owner, is ready, and matches
  `generation_config.syllabusId`. The save RPC does validate this; direct
  authenticated table inserts are separately granted. This is a confirmed
  local policy gap, and the v2 candidate adds the syllabus/scope checks to its
  restrictive and permissive insert policies plus a guard trigger.
- Migration 001 creates `google_credentials_select_own`, which allows a user's
  own credential row under RLS; that row stores access and refresh tokens.
  Whether this is an actual browser exposure depends on effective table and
  column grants, which were not inspected live. The separate
  `google_credentials_access_hotfix.sql` is the existing review artifact for
  removing browser access. No credential rows were queried.
- The repair candidate requires a trusted executor/table owner with specific
  privileges and expected object shapes. Check the preflight output; do not
  assume the SQL Editor role meets the requirement.
- The score path now has local artifacts, but the old README and
  `IMPLEMENTATION_ROADMAP.md` still describe automated ingestion as not built.
  Those descriptions are stale relative to the current worktree and should be
  revised after the new path is reviewed and verified. The new path is not yet
  proven operational.
- Google Forms score ingestion requires a server secret and a Forms-bound Apps
  Script submit trigger. Neither external setup is demonstrated by source files.
- OAuth, Gemini, Supabase, Google Forms and score integration all need external
  project credentials/configuration and controlled runtime verification. No
  credentials were inspected or disclosed.
- Existing SQL repair assumptions about exact live columns, vector dimensions,
  constraints, function ownership/security/grants, RLS policies, triggers,
  role memberships and table/column ACLs cannot be settled from local source.
  Some ownership, grants, and full catalog visibility may also require a
  sufficiently privileged SQL Editor session.
- Migration 002 does not set explicit execute grants for
  `match_syllabus_chunks`; the repair candidate also leaves its ACL untouched.
  PostgreSQL default ACLs may be changed by the database owner, so effective
  anon/authenticated/service-role execute must come from the preflight, not an
  assumption. The function is `SECURITY INVOKER` and chunk RLS applies, so
  public execute alone does not demonstrate data disclosure.
- The repair filename is `reconcile_test_workflow_v2.sql`, while its policy
  ownership marker string is `... policy v3`. The marker is internally
  consistent within the repair's preflight, policy comments, and postflight;
  the separate read-only preflight does not inspect this marker. Operators
  should note the version-label difference when reviewing ownership.
- SQL cannot establish that app/PostgREST writes are frozen, a recovery point is
  restorable, a selected project ref is the intended one, or the browser and
  Google Forms behavior is correct. Those require external/manual checks.

## Smallest safe implementation plan

1. Preserve and review the current dirty worktree. Confirm intended changes
   before replacing or consolidating any SQL repair artifact; do not infer live
   state from the filenames or local migration ledger.
2. Compare the latest source/migrations with the current callers. Resolve the
   `replace_test_question` and `attest_test_review` migration gaps through the
   existing repair candidate after live preflight; do not add a second
   overlapping definition while the live migration history is unknown.
3. Review the score webhook and Apps Script as one integration: verify secret
   handling, score totals/response shape, retry behavior, publication/form
   ownership mapping, and add the webhook secret to the deployment example and
   operator instructions without exposing its value.
4. Refresh stale README/roadmap setup notes after score ingestion design is
   accepted. Keep them clear that deployment and live verification remain open.
5. Run the read-only v2 preflight manually in the intended Supabase SQL Editor,
   save the outputs, and compare each result against the candidate’s
   preconditions/postconditions. Reconcile migration state, backup/PITR, and
   project ref manually. Do not execute the repair as part of this plan.
6. After the implementation is reviewed, run the repository’s local lint/build
   and focused tests, then perform controlled local/provider integration checks.
   Comprehensive end-to-end testing and production deployment remain separate
   phases.

## Exact next actions in priority order

1. Inspect and reconcile the dirty worktree and all SQL artifacts; confirm which
   edits are intended to remain before touching overlapping files.
2. Have an authorized operator confirm the intended Supabase project ref, then
   run and save the read-only preflight output. Reconcile actual migration state,
   object signatures, grants, policies, triggers, and vector column details.
3. Review candidate ownership, `SECURITY DEFINER` execution context, function
   grants, and table ACL changes against that live output; do not run the repair.
4. Check `google_credentials` effective browser grants and policies without
   querying stored values; consider the separate hotfix only if actual exposure
   is found.
5. Review the score ingestion contract and document/configure the webhook
   secret and per-Form Apps Script trigger prerequisites; reconcile the stale
   README and roadmap statements.
6. Use preflight evidence to decide whether the repair proposal needs edits.
   Confirm recovery point and write freeze separately before any future
   authorized execution. Keep it NOT FOR EXECUTION meanwhile.
7. Run local lint/build/focused tests and controlled integration checks in a
   later implementation/verification phase; schedule comprehensive E2E and
   production deployment separately.

## Chunk 2: syllabus to RAG to question generation (2026-10-22)

### Actual local flow

1. `app/dashboard/generate/page.tsx` calls `SyllabusStep` for PDF selection or
   pasted text, then posts to `/api/syllabus`. `components/syllabus/file-upload.tsx`
   accepts PDF files; `components/syllabus/syllabus-step.tsx` submits either
   multipart PDF or JSON text.
2. `app/api/syllabus/route.ts` requires a Supabase user. It accepts PDFs up to
   15 MB and pasted text between 50 and 500,000 characters. The PDF path uses
   `lib/pdf/parser.ts` and `pdf-parse`; unreadable, password-protected, scanned
   or text-empty documents return a safe parser error. OCR is not present.
3. Both paths call `lib/syllabus/ingest.ts`: `detectStructure` and
   `chunkSyllabus` split cleaned text; `generateEmbeddings` makes 768-dimension
   Gemini vectors (or explicitly marked mock vectors); syllabus chunks are
   stored and the syllabus becomes ready only after insertion succeeds. A
   failed stage marks the syllabus as error. Current PDF extraction does not
   preserve page boundaries, so page metadata remains null.
4. The configure action in `app/dashboard/generate/page.tsx` posts the syllabus
   ID, subject, scope, count and difficulty to `/api/generate`. That route
   checks the authenticated owner and ready status, rejects mock AI mode, and
   calls `lib/rag/retrieval.ts`. Retrieval embeds a scope/instructions query,
   invokes `match_syllabus_chunks`, enforces syllabus/unit/topic scope, and
   never widens to unrelated syllabi. The route rejects empty evidence and
   chunks without Gemini embedding provenance.
5. `lib/ai/prompts.ts#buildGroundedGenerationPrompt` receives retrieved chunk
   text and explicitly limits generation to it. `lib/ai/gemini.ts#generateGroundedQuestions`
   retries malformed structured responses once. `lib/ai/grounded-response.ts`
   and `lib/validation/schemas.ts` require non-empty question/topic, four
   non-empty options, a 0–3 correct-answer index, and an explanation; model
   supplied IDs/provenance are discarded. `assessQuestionQuality` derives
   candidate source IDs from lexical overlap, and the support pass remains
   advisory. Questions remain in `needs_review` for faculty verification.

### Changes and focused verification

- Confirmed retrieval text was already passed into the active generation prompt;
  there was no missing RAG-to-generation connection to rebuild.
- Fixed a guardrail gap: previously a structurally valid question with no
  lexical candidate source was returned with a warning and empty provenance.
  `app/api/generate/route.ts` now declines the whole response with 422 if any
  generated question has no candidate source. `lib/rag/provenance.ts` also
  rejects empty source ID lists, so other callers cannot treat an empty list as
  valid provenance.
- Updated the grounded prompt to treat syllabus context as untrusted data, not
  instructions.
- Focused check: `npm.cmd test` passed all 11 existing tests in
  `tests/rag-flow.test.mjs`. No end-to-end provider or Supabase request was
  made. The regular `npm test` PowerShell shim was blocked by execution policy;
  invoking the same script through `npm.cmd` succeeded.

### Remaining limits

- Candidate source assignment uses token overlap; it is not a proof that the
  source entails the question or keyed answer. The second Gemini support review
  is advisory, and a human faculty review remains the publication gate.
- No live Supabase retrieval, Gemini embedding/generation, PDF upload, or Google
  service was exercised. Verify provider credentials, vector RPC/schema and
  upload limits in the intended deployment before relying on runtime behavior.
- OCR and page-aware PDF extraction remain absent; these were not needed to
  connect the existing flow and were not changed.

## Database workflow repair follow-up (2026-10-22)

- Supplied live evidence confirms `public.questions.explanation` is absent and
  the publish query fails with SQLSTATE `42703`. The API now reports this as
  HTTP 503 with a schema-repair instruction. It does not bypass question
  explanation or provenance requirements.
- Supplied live evidence also reports that `save_draft_test` drops explanation
  and source IDs and stores default grounding/validation values. This conflicts
  with migrations 007/008 and the current caller. Supplied prior catalog checks
  reported edit, regeneration, attestation and publish RPCs missing; verify all
  findings with a fresh preflight because the repository cannot prove current
  live state.
- `reconcile_test_workflow_v3_review_candidate.sql` is a separately named,
  NOT FOR EXECUTION review copy of the existing v2 candidate. Existing SQL
  artifacts remain preserved. Fresh catalog evidence, recovery planning, and
  review of ownership, RLS, grants, triggers and policies are prerequisites.
- The reviewed read-only preflight explicitly reports `questions.explanation`
  as a required repair prerequisite. It also enumerates the Form-creation
  coordination table/RPCs from migration 013 and the response-idempotency
  index from migration 012. The new read-only postflight reports the
  workflow columns, function contracts/security modes, grants, RLS, policies
  and triggers; catalog PASS results do not prove application behavior.
- A focused unit test covers detection of SQLSTATE `42703`; the complete
  `node --test tests/rag-flow.test.mjs` run passed 12/12 tests. The explicit
  `node node_modules/typescript/bin/tsc --noEmit` check passed, and
  `npm.cmd run lint` completed successfully. `node
  node_modules/next/dist/bin/next build` completed successfully, including
  compilation, lint/type validation, static page generation and build traces.
  No live database change or end-to-end workflow success is claimed.

### Next operator action

Verify the Dashboard project ref and recovery point, run the reviewed read-only
preflight in that project, preserve its output, and reconcile every reported
schema/function/ownership/RLS/trigger/grant result against the candidate. Stop
on any unexpected object or privilege. Only after an authorized repair should
the read-only postflight and a separate draft → edit/regenerate → review →
publish → Google Form → score-ingestion test be run. OAuth hotfix and migrations
012/013 remain separate and require independent prerequisite review.

## Chunk 3: question review, drafts and publishing (2026-10-22)

### Local workflow findings

- `app/dashboard/generate/page.tsx` renders generated questions in
  `components/questions/question-editor.tsx` and `question-card.tsx`. Faculty
  can add/remove questions and edit topic, question text, explanation, four
  options, and the keyed answer. `validateQuestions` checks completeness;
  server schemas revalidate payloads. Duplicate options and non-integer answer
  indexes are now rejected in the editor before submission.
- Draft creation uses `POST /api/tests` and `save_draft_test`; editing uses
  `PATCH /api/tests/[id]` and `update_test_questions`. Both routes authenticate,
  enforce ownership/readiness/draft status, verify retrieved Gemini evidence,
  and only report success after their persistence call succeeds. The save UI
  now guards repeated in-flight submits. The detail edit UI also handles
  network/invalid-JSON failures without a false success or stuck loading state.
- `app/dashboard/tests/[id]/page.tsx` loads persisted questions and candidate
  source passages. `TestDetailView` now refreshes its displayed question state
  from server props when not editing, so a successful edit or regeneration
  does not leave the review screen showing stale in-memory questions.
- Publish UI submits an explicit faculty confirmation. `POST
  /api/tests/[id]/publish` reloads the owned draft and ordered question rows
  from Supabase, validates them, records `attest_test_review`, then calls
  `publish_test`; it does not publish the client’s in-memory question array.
  Google Forms creation is enabled only for `published` tests and loads the
  persisted ordered questions (including option order and correct-answer
  index) to build the quiz. It saves the resulting Form ID and URL to the test.

### Changes and focused checks

- Changed `components/questions/question-editor.tsx` to reject repeated answer
  options and invalid non-integer answer indexes before saving.
- Changed `components/tests/test-detail-view.tsx` to refresh displayed data
  after server refreshes and to catch transport/JSON errors during edit saves.
- Changed `app/dashboard/generate/page.tsx` to ignore repeated in-flight draft
  save submissions.
- Focused checks: ESLint passed for those three changed TSX files; TypeScript
  `tsc --noEmit` passed; `npm.cmd test` passed all 11 existing RAG-flow tests;
  `git diff --check` passed. No
  live Supabase or Google Forms request was made.

### Database and external verification still required

- The current app calls `attest_test_review` and the regeneration route calls
  `replace_test_question`. These are defined in the local v2 repair candidate,
  but are not defined in migrations 001–011. Migration 009's local publisher
  checks persisted question content/count but does not itself record the
  faculty attestation that the route now requires. The intended Supabase
  project must be checked read-only to confirm the deployed versions,
  permissions, and triggers; no SQL was run.
- The v2 repair candidate's publication gate checks the persisted question
  set, ownership, provenance, count, and question structure. Until that
  candidate or equivalent reviewed migration is confirmed in the live schema,
  the app’s staged attest-then-publish sequence and protection against direct
  writes between those calls are not established by local migration history.
- `save_draft_test` creates a new test for each successful call; there is no
  persistent idempotency key. The UI prevents ordinary duplicate in-flight
  clicks, but a retry after an ambiguous network outcome may create another
  draft. Confirm whether this retry risk is acceptable before adding an
  idempotency table/column or changing the RPC contract.
- Supabase RLS, RPC grants/owners/security mode, published-content triggers,
  concurrent publish/edit behavior, and Google Forms API behavior remain
  unverified against the intended project and connected Google account.

## Chunk 4: Google OAuth and Google Forms (2026-10-22)

### Local flow and security model

- `app/api/google/connect/route.ts` requires an app session and creates a
  random, short-lived, HttpOnly, SameSite=Lax state nonce. The callback
  `app/api/google/callback/route.ts` checks the nonce and signed-in user before
  exchanging the authorization code. Both routes redirect using
  `NEXT_PUBLIC_APP_URL` (the connect route now safely falls back to request
  origin when it is unset).
- `lib/google/auth.ts` requests `forms.body` and `drive.file`. OAuth needs
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and
  `NEXT_PUBLIC_APP_URL`. The OAuth client and token exchange run in
  server-only modules. Access/refresh tokens are stored and refreshed through
  `createServiceRoleClient`; values are not sent to the browser or logged.
  When Google returns explicit scopes, the callback now checks that both
  requested scopes were granted before storing the credentials.
- `app/api/forms/route.ts` authenticates the faculty user, checks test
  ownership and `published` status, reloads ordered persisted questions,
  validates question shape/options/count, and only then calls
  `lib/google/forms.ts`. Forms are quizzes with required radio choices, one
  correct answer and one point per item. The saved Form ID and responder URL
  are written to that same published test; the route verifies that an owned
  row was actually updated before returning success.
- `components/forms/create-form-button.tsx` displays the returned Form link,
  provides a connect link when OAuth is missing, prevents duplicate in-flight
  clicks, and offers recovery when a created Form could not be fully
  associated. A reused Form is reported as ready rather than newly created.

### Changes made

- Added `supabase/migrations/013_google_form_creation_coordination.sql`. It
  revokes browser grants on `google_credentials` and drops its owner-read
  policy, while retaining server-side `service_role` access. It adds a
  published-test-scoped, 10-minute creation lease and recovery Form ID, with
  owner-checked RPCs to claim, record and release the lease. This prevents
  concurrent requests from creating separate Forms during the lease and lets
  retries recover a known partial Form. It is a local migration only and was
  not run.
- `lib/google/forms.ts` now records a newly created Form ID through a callback
  before adding questions, so a batch-update or URL-read failure can retry
  against the same Form. Google error text is sanitized before it reaches the
  API response.
- `app/api/forms/route.ts` uses the lease, validates the saved question set,
  and requires an actual returned test row for successful association.
- `components/forms/create-form-button.tsx`, `lib/google/auth.ts`, and
  `app/api/google/connect/route.ts` handle repeated clicks, scope checks, and
  missing base-URL configuration respectively.

### Focused checks and remaining verification

- Local code review confirms the Form request maps the saved four options and
  keyed answer to Google Forms quiz grading. No Google account, OAuth exchange,
  Forms API request or production record was used in this chunk.
- The database migration has not been executed or validated against PostgreSQL.
  Confirm the intended project ref, migration state, table owners/grants and
  whether `google_credentials_access_hotfix.sql` was already applied. The new
  migration is intended for a reviewed migration workflow; do not also apply
  the overlapping hotfix without reconciling the live state.
- The previous `001_initial_schema.sql` creates an owner-read policy for
  `google_credentials`. Effective table/column grants were not inspected live;
  until the hotfix or migration 013 is confirmed deployed, server-only token
  handling in code does not establish that browser roles cannot query tokens.
- Google Cloud must have Forms API and Drive API enabled, a configured OAuth
  consent screen/test user, and a Web OAuth client whose authorized redirect
  URI exactly matches `GOOGLE_REDIRECT_URI`. These settings and required scopes
  need a real user consent and successful live API round-trip to verify.
- Form creation lease expiry is 10 minutes. A provider call that remains
  unresolved beyond that lease could permit a later retry to claim the test;
  verify realistic API timeout behavior before production use. Partial Forms
  with a different item set are intentionally left for manual inspection.
- README setup notes predate the score-sync and new lease migration. Review
  deployment steps against the final migration chain before enabling this
  feature in production.

## Chunk 5: Google Form responses and score ingestion (2026-10-22)

### Local path and data handling

- No polling or Google Forms response API reader exists. The local response
  path is the Forms-bound installable submit trigger in
  `scripts/google-forms-score-sync.gs`, which obtains graded item scores and
  posts the Form ID, response ID, total points, graded-item count and timestamp
  to `app/api/scores/ingest/route.ts`.
- The webhook authenticates a server-only shared secret with a timing-safe
  comparison, maps the Form ID to one published test, validates the response
  and question count, computes percentage from the one-point-per-question quiz,
  then upserts by `(test_id, google_response_id)`. It returns generic errors
  and does not log student response values. Duplicate trigger deliveries update
  the existing score row when the idempotency migration has been applied.
- The scores table already stores student name/email, score, total, percentage
  and submission time. The faculty dashboard reads saved rows through the
  session Supabase client and the `scores_select_own` policy joins access to
  tests owned by that faculty user. A query failure previously looked like an
  empty score list; the score page now displays a load error instead.

### Changes and checks

- The Apps Script now sends `totalQuestions`; webhook validation requires it to
  match the published test question count before accepting the score. This
  checks that all graded Form items correspond to the saved one-point question
  set used to create the quiz.
- Updated `app/api/scores/ingest/route.ts`,
  `lib/validation/schemas.ts`, `scripts/google-forms-score-sync.gs`, and
  `app/dashboard/scores/page.tsx`. Existing dashboard readers and score schema
  are reused; no analytics subsystem or response contents were added.
- Local inspection confirms Google Forms item grading sends the correct answer
  and one point per question, matching the score aggregation. No real Form
  response, Apps Script trigger, Google API call, or production data was used.

### Remaining setup and verification

- Apply and verify `supabase/migrations/012_idempotent_google_form_scores.sql`
  in the intended Supabase project. Without its unique index, the webhook's
  `upsert` cannot provide response-level deduplication and returns a schema
  readiness error.
- Configure `GOOGLE_FORMS_WEBHOOK_SECRET` only in server deployment secrets
  and matching Apps Script project properties, then install the form-submit
  trigger for each generated Form. `.env.example` now names the variable but
  contains no secret value; no value was read or written during this work.
- Confirm Apps Script authorization, respondent-email collection and Forms
  quiz grading behavior with an approved test Form/response. Email collection
  is a Google Form setting; if disabled, the integration stores an empty email
  and generic respondent label. No live Google or Supabase verification was
  performed.
- README and `IMPLEMENTATION_ROADMAP.md` still say score ingestion is not
  implemented. The closure review updates those setup descriptions while
  retaining the pending deployment and live verification steps.

## Chunk 6: implementation closure (2026-10-22)

### Verdict and repository state

**PARTIALLY COMPLETE.** The local application flow exists across syllabus
ingestion, scoped retrieval/generation, question review/drafts/publication,
Forms creation, and Apps Script score ingestion/dashboard. Static and existing
unit checks pass. Live Supabase schema alignment, OAuth/Forms behavior, and
score webhook operation remain unverified, so the project is not production
ready.

The worktree was dirty before this closure review. All modified and untracked
files were preserved; no reset, checkout, cleanup, or commit was performed.
The significant closure edits are `.env.example` (webhook secret name only),
`README.md` (manual DB prerequisites, server-only secret handling, OAuth and
score setup), `IMPLEMENTATION_ROADMAP.md` (score verification steps), and this
status document. Earlier chunk changes to application code and candidate SQL
remain present and are not attributed to this closure pass.

### Diff and sensitive-data review

- Reviewed the tracked source diffs for the app routes, review UI, Google
  integration, validation and RAG provenance. The changes correspond to the
  requested workflow modules; no unrelated UI or database subsystem was added.
- Scanned the reviewed application/configuration/docs paths for common API key,
  bearer token and private-key literal patterns. No credential-like literal
  was found. `.env.local` and untracked `backups/` contents were deliberately
  not opened; existing secrets or user data there were not inspected.
- Reviewed logging/error paths in the Forms and score handlers. The score
  webhook does not log payload/student fields; Google API messages are
  redacted and bounded before returning. No debug logging was added.
- `git diff --check` passed. Git emitted only its line-ending conversion
  warnings for modified files.

### Focused checks actually run

- `npm.cmd run lint` — passed (`eslint .`).
- `npm.cmd test` — passed: 11 tests, 0 failures. The repository test script
  covers the RAG flow; it is not an end-to-end Google or Supabase test.
- `npx.cmd tsc --noEmit` — passed.
- `npm.cmd run build` — passed; Next.js compiled, type-checked, generated all
  19 static pages and collected build traces.
- No automated PostgreSQL migration execution, browser flow, Gemini request,
  Google OAuth/API call, Forms submission, or score webhook request was run.

### SQL and external service status

- Local migrations 012 and 013 and the workflow repair/preflight files are
  review artifacts only. None was executed against a live database. A source
  migration's presence does not establish that it is deployed.
- Before database changes, an authorized operator must confirm the Supabase
  project ref, migration ledger, backup/recovery point, write freeze, schema,
  RPC signatures/owners/security modes, RLS, grants, triggers and vector
  extension/dimensions. Run and save the read-only v2 preflight first; compare
  its output with the candidates. Reconcile migration 013 with the separate
  OAuth hotfix rather than applying both blindly.
- Google OAuth and Forms remain local-code-only. Configure consent/test user,
  Forms and Drive APIs, the exact callback URI, and required scopes; perform an
  approved OAuth and Form creation round-trip. Configure the score webhook
  secret and Forms-bound Apps Script trigger, then submit an approved test
  response and verify duplicate delivery updates the same score.

### Separate end-to-end verification phase

1. Use an isolated Supabase project and approved disposable Google account/Form;
   confirm the project ref, schema, grants and migration state first.
2. Upload a text PDF and paste equivalent syllabus text; verify extraction,
   chunking, embeddings and ready/error transitions without exposing document
   text in logs.
3. Generate a small scoped question set; verify retrieved source IDs and
   question structure, then review, edit, save, reload and regenerate a draft.
4. Test owner boundaries and invalid question cases; verify review attestation
   and publish use persisted rows and reject incomplete or stale drafts.
5. Create a quiz and confirm saved Form ID/URL, options, correct answers and
   points. Exercise a partial-failure recovery and concurrent retry.
6. Install the Apps Script trigger, submit one approved response, verify the
   score and percentage in the owning faculty dashboard, retry that same
   response to confirm idempotency, and check another faculty account cannot
   read it. Test malformed payload, unknown Form, wrong question count and
   duplicate delivery without using real student data.

### Work to defer until verification passes

- Do not deploy or promote the candidate SQL until live preflight, ownership,
  backup/recovery and operator review are complete.
- Do not configure production OAuth/webhook secrets, install triggers on
  production Forms, or enable production score ingestion before the isolated
  round-trip and ownership/idempotency checks pass.
- After approved verification, apply reviewed migrations through the intended
  release process, configure production environment variables and OAuth
  redirect/consent settings, then deploy. Keep live database repairs separate
  from ordinary application deployment.

## Chunk 7 — final database readiness review

Audit date: 2026-10-22. This section is a static review of local SQL and
application callers. No Supabase connection was made and no SQL was executed.
The worktree was already dirty; its modified and untracked files were preserved.
The captured `git status --short` includes application changes, `backups/`,
`docs/`, migrations 012/013, the workflow repair candidates, and the OAuth
hotfix. The complete local SQL review set is migrations 001–013,
`supabase/repairs/preflight_test_workflow_v2.sql`, the separate
`preflight_test_workflow_v2_reviewed.sql` copy, both
`reconcile_test_workflow.sql` and `reconcile_test_workflow_v2.sql`, and
`google_credentials_access_hotfix.sql`; verification SQL was also recognized
as existing review material. The backup directory contents were not inspected.
No application code was changed in this review.

### Migration dependency and order review

The numeric sequence below describes local dependencies, not the live ledger
or a recommendation to replay files. Migrations 001–011 are tracked baseline
files; 012 and 013 are untracked candidate migrations.

| Artifact | Local dependency and effect | Manual review decision |
|---|---|---|
| 001 `initial_schema` | Base profiles, tests, questions, scores, OAuth credentials, initial RLS/policies/triggers. | Historical baseline only; first establish whether objects are already live. |
| 002 `syllabus_knowledge_base` | Depends on 001; adds vector extension, syllabus/chunk tables, owner reads, and `match_syllabus_chunks(vector(768),uuid,text,text,integer)`. | Review extension/schema, exact signature, grants and actual vector dimensions. |
| 003 `question_grounding_fields` | Depends on questions from 001; adds provenance/validation columns. | Manual review; compare live columns and constraints. |
| 004 `tests_syllabus_link` | Depends on tests (001) and syllabi (002); adds syllabus FK and generation configuration. | Manual review; check existing FK and data shape. |
| 005 `correct_question_validation_comments` | Comments/metadata for question validation fields from 003. | Manual review; confirm whether already recorded. |
| 006 `save_draft_test_atomically` | Depends on tests/questions (001); defines `save_draft_test(uuid,jsonb,jsonb) returns jsonb`. | Manual review; later migrations replace this routine. |
| 007 `question_explanations_and_quality` | Depends on 006 and questions; adds explanation/quality data and revises draft save. | Manual review; verify column nullability and routine body/ACL. |
| 008 `review_metadata_and_atomic_question_updates` | Depends on syllabus scope (002/004) and question fields; defines `update_test_questions(uuid,text,text,text,jsonb) returns void`. | Manual review; reconcile exact overload and argument names. |
| 009 `publish_reviewed_tests` | Depends on tests/questions and save/update routines; adds publish guard/RPC and changes policies. | Manual review; inspect trigger order, owner, SECURITY DEFINER and grants. |
| 010 `security_hardening_draft_published_access` | Hardens tables/RLS and function privileges after 007–009. | Manual review; compare effective ACLs, memberships, policies and callers. |
| 011 `validate_question_provenance` | Depends on 002, 004 and 010; validates source chunks and revises publish gate. | Manual review; confirm stored scope JSON, provider metadata and function rights. |
| 012 `idempotent_google_form_scores` | Depends on `scores` from 001; adds nullable `google_response_id` and unique `(test_id,google_response_id)` index used by score-ingest upsert. | Candidate only. Check live column/index and duplicate non-null IDs first; index creation can fail on duplicates. |
| 013 `google_form_creation_coordination` | Depends on tests/OAuth tables (001), `auth.users`, and published ownership/status. Adds lease table and three RPCs; hardens OAuth ACLs. | Candidate only. Review definer owner/rights, existing same-name table shape, lease recovery and overlap with OAuth hotfix. |
| `reconcile_test_workflow_v2.sql` | Standalone candidate for review/publish, RLS, constraints, ACLs and app RPCs; includes `replace_test_question` and `attest_test_review`, absent from 001–011. | Manual review only; never a migration-ledger substitute or automatic execution. Compare every live function/policy/ACL. |
| `google_credentials_access_hotfix.sql` | Standalone OAuth ACL/policy repair; overlaps the credential ACL portion of 013. | Alternative/manual review only. Do not blindly apply alongside 013. |

Migrations 001–011 do not define `replace_test_question(uuid,uuid,jsonb)` or
`attest_test_review(uuid)`, although regeneration and publish routes call them;
the workflow repair candidate defines both. `app/api/forms/route.ts` calls
`claim_google_form_creation(uuid,uuid) returns jsonb`,
`record_google_form_creation_form(uuid,uuid,text) returns boolean`, and
`release_google_form_creation(uuid,uuid,boolean) returns void`; these are
defined only by migration 013. Reconcile exact overloads, PostgREST argument
names, output types, owners, SECURITY DEFINER modes, fixed search paths and
grants before any replacement or replay.

Migration 012 is required for the response upsert's conflict target. The
nullable column permits legacy scores without a response ID. A populated
pre-existing column or index changes the duplicate-risk assessment; inspect
index definitions and duplicate counts without putting student identifiers
in output. Migration 013 and the OAuth hotfix both remove the owner-read policy,
revoke browser table/column grants, and grant `service_role` SELECT/INSERT/
UPDATE. Choose one reviewed ACL path after inspecting live state. Migration
013's `CREATE TABLE IF NOT EXISTS` does not verify the shape of an existing
same-named table. The workflow repair also changes tests/questions privileges,
policies and functions; it revokes elevated table privileges from
`service_role`, so confirm no server caller relies on them.

### Preflight review and operator procedure

The original `preflight_test_workflow_v2.sql` is largely read-only catalog
queries and does not execute app RPCs or read table rows, tokens or embedding
vectors. However, it selects `pg_get_functiondef`, printing full function
source that could disclose an accidentally embedded literal. Its section 11
label claims sequence ACL coverage the query does not provide, and it omits
the executor's `REFERENCES` privilege on `auth.users`, needed by the workflow
repair's reviewer FK. Preserve that original; use the separate corrected
candidate [`preflight_test_workflow_v2_reviewed.sql`](../supabase/repairs/preflight_test_workflow_v2_reviewed.sql)
for read-only review. The copy omits function bodies, corrects the sequence
coverage description, and reports only `auth.users` relation existence and
effective REFERENCES privilege.

An authorized operator should:

1. Independently verify the intended Supabase project ref in the Dashboard
   URL and record it. SQL session metadata may not expose a project ref.
2. Run the corrected read-only preflight in that project's SQL Editor; save
   every result set with timestamp and project ref. Do not run a repair or
   migration as part of preflight.
3. Obtain the actual migration ledger (`supabase migration list --linked` in
   the explicitly linked project, or approved equivalent) and reconcile it
   with catalog output; filenames do not establish applied state.
4. Compare table/column types/defaults/constraints, routine overloads and
   metadata, RLS/policies, triggers, effective direct/inherited grants, vector
   extension/type/dimension, score unique index and any coordination table
   against the candidate SQL.
5. Before proposing a write, confirm a recoverable backup/PITR point, recovery
   plan, required write freeze and explicit operator approval. Capture current
   OAuth ACL/policy metadata only; never query credential rows.

Preflight cannot prove a backup is restorable, that app writes are frozen, that
Google consent/API access is valid, or that SQL session identifiers match the
intended project. It cannot establish semantic Form/score correctness. Do not
infer live state from local files or earlier reports.

### Decision

**READY FOR PREFLIGHT** means only that the corrected candidate is suitable for
an authorized read-only metadata review after independent Dashboard project
verification. The original preflight is not recommended as-is. This is not a
statement that the live database is ready or that any write is approved. No
migration is approved for automatic execution. Migrations 001–013 remain
manual-review items against the actual ledger/schema; 012 and 013 are
unverified candidate additions, while the workflow reconciliation and OAuth
hotfix remain standalone repair proposals.

Next manual action: an authorized operator confirms the target project ref,
runs only the corrected read-only preflight, and supplies saved result sets and
the actual migration ledger. Before any write proposal, evidence must include
matching project identity, ledger/catalog reconciliation, exact routine and
privilege comparisons, unique-index/data prerequisites, backup/PITR recovery
evidence, and an approved freeze and recovery plan.

### Local verification update (2026-10-23)

- The existing v3 workflow repair review candidate remains **NOT FOR EXECUTION**
  and is not reconciled against a complete live catalog export. Its current
  version keeps `service_role` table grants unchanged, limits browser writes on
  `tests`/`questions` to the observed app contract, and leaves migrations 012/013
  and OAuth ACL changes separate. Review those ACL changes against complete
  live grant and role-membership output before any operator applies them.
- The read-only workflow postflight checks expected workflow columns, RPC
  interfaces/security modes, six repair triggers, owned policies, browser
  grants, and OAuth browser table access. It reports catalog state only and
  cannot prove end-to-end app behavior.
- Current local checks: `npm.cmd test` passed 13/13; `npx.cmd tsc --noEmit`
  passed; `npm.cmd run lint` passed; `NODE_OPTIONS=--max-old-space-size=4096
  npm.cmd run build` passed after the default-heap build ran out of memory; and
  `git diff --check` passed. The untracked workflow SQL files also passed a
  trailing-whitespace scan. No live SQL was run and no Supabase change is
  claimed.
- Live project identity, ledger state, exact routines/owners/grants/memberships,
  complete policies/triggers, and end-to-end draft/edit/review/publish behavior
  remain unverified. Migration 012 is a separate prerequisite for score
  idempotency; migration 013 and OAuth ACL changes require separate review.
