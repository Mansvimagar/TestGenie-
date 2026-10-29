# TestGenie Completion Status (living report)

## Step 1 - Dev server

**Evidence**
- No `node.exe` processes and nothing listening on 3000/3001/3002 at start (no stale servers; the old PID 16288 is gone).
- `.env.local` (names/hosts only checked): `NEXT_PUBLIC_APP_URL` and `GOOGLE_REDIRECT_URI` both use host `localhost:3000`. `.env.example` and README also use 3000 (Google redirect `/api/google/callback`, Supabase redirect `/auth/callback`).
- `package.json` `dev` is `next dev` (default port 3000). Nothing sets 3001.
- `npx next dev -p 3000` started cleanly ("Ready in 3.8s"), `GET /` returned 200, no crash output.
- ERR_CONNECTION_REFUSED on :3001 was simply because nothing runs there; 3001 is not a configured port.

**Use port 3000 only.**

```powershell
# clear any stale servers (only if something is listening)
Get-NetTCPConnection -State Listen -LocalPort 3000,3001 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
npm run dev
```

**Checks after Step 1 (no code changed):** tsc OK, npm test 15/15, eslint clean, build passed.

DB changes: none.

## Step 2 - Generation failure

**Evidence**
- User terminal: `POST /api/generate 422 in ~305-309s`, log `Gemini grounded generation request failed ... message: 'exception TypeError: fetch failed sending request'`. Retrieval, embedding and chunk-provenance checks had already passed (the Gemini call was reached), so the failing stage is the Gemini `generateContent` call. The ~300s duration matches Node's default fetch headers timeout: the provider never answered.
- This run did NOT show `RangeError: Array buffer allocation failed`. Not reproduced yet; see memory note below.
- `lib/ai/gemini.ts` hard-coded `gemini-3.8-flash`. Direct calls from the CLI with the real key (key never printed): models list OK in 0.3s; a trivial JSON prompt to `gemini-3.8-flash` hung >120s; `gemini-3.7-flash` hung >45s; `gemini-3.5-flash` 200 in 2.7s; `gemini-3-flash-preview` 200 in 5.8s; `gemini-3.1-flash-lite` 200 in 10.7s; `gemini-2.5-flash` and `gemini-2.0-flash` (the documented GEMINI_MODEL) return 404.
- So connectivity, DNS, the key and RAG are fine; the model choice is the cause.

**Fix:** `lib/ai/model.ts` (default `gemini-3.5-flash`, optional `GEMINI_GENERATION_MODEL` override, 90s request timeout) used by `lib/ai/gemini.ts`; extra log fields (cause code, model, elapsed, prompt size, chunk count); `app/api/generate/route.ts` now has a correlation ID, per-stage tracking, a sanitized stage log and stage-specific UI errors with a short ref.
**Test added:** model resolution/timeout regression in `tests/rag-flow.test.mjs`.
**DB changes:** none.
**Checks:** npm test 16/16, eslint clean. `tsc` and `build` crashed with a native allocation failure on this machine (commit memory nearly exhausted: ~258 MB virtual free of ~20 GB, with the dev server running); not a type error. Re-run after freeing memory.
**Not yet verified:** a real successful generation after the fix; RAG integrity audit and embedding-dimension confirmation (needs Step 3 SQL output); RangeError root cause.

## Step 3 (feature work) - Student identity, links, scores

**Changed:** `lib/google/form-structure.ts` (new; form request builder + `formMatchesQuestions`, 4 required ungraded short-answer items "Full Name", "Roll No", "Class", "Division" first, graded items shifted by 4, still a quiz), `lib/google/forms.ts` (uses it), `lib/scores/identity.ts` (new; `Name | Roll X | Class Y | Div Z` format/parse), ingest schema + route, `scripts/google-forms-score-sync.gs` (reads identity by item title, excludes them from graded count), `components/scores/scores-table.tsx` (Roll No/Class/Div columns), `app/dashboard/scores/page.tsx` (explicit `tests.user_id = signed-in user` filter on top of RLS), `components/forms/create-form-button.tsx` and `components/tests/test-row-actions.tsx` (student link, Copy link, Open, faculty Edit link built from formId).
**DB changes:** none applied. Optional migration proposed in chat, awaiting approval.
**Tests:** `npm test` 18/18, eslint clean. `tsc --noEmit` and `build` NOT verified: native out-of-memory crash while the dev server (~580 MB) is running; rerun after stopping it.
**Existing forms:** forms created before this change have no identity items; recovery matching is strict, so they are returned as-is via the saved URL but would not match a retry through `createGoogleForm`.

## Server-side "Sync scores"

**Added:** `POST /api/scores/sync` (owner-scoped, published test with a Form ID), `lib/google/responses.ts` (forms.responses.list, paged, max 20 pages), `lib/google/response-mapper.ts` (score from `totalScore` or per-answer grades; identity answers matched by question ID from the form definition), `components/scores/sync-scores-button.tsx` on the test detail page. Scope `forms.responses.readonly` added to `GOOGLE_SCOPES` (consent + callback check). Errors: not connected / scope missing / token expired return 409 with `reconnectRequired` and the UI shows a "Reconnect Google" link. Writes reuse the `(test_id, google_response_id)` upsert. Webhook route and Apps Script unchanged.
**DB changes:** none. The scores-columns migration is NOT added.
**Checks:** tsc OK, npm test 20/20, eslint clean, build passed.
**Not verified live:** no real Google call was made. Needs: Google Cloud consent screen + Forms API scope enabled, reconnect Google, submit a response, click Sync scores.

## Bug fixes: missing identity fields on old Form, clipboard

- **Diagnosis (live, owner credentials, counts only):** test `7a6901d5` ("mlops") was created 2026-10-29 12:17Z and last updated 12:20Z (~17:47-17:50 IST). `lib/google/form-structure.ts` and the `forms.ts` change were written at 17:59 IST (12:29Z), after the Form existed. The Form has 3 items (all graded choice items), 0 identity items, `isQuiz: true`, `emailCollectionType: DO_NOT_COLLECT`, and 1 response. Created by OLD code; the new code path (`createGoogleForm` -> `buildFormRequests`) builds 4 identity items + questions and is covered by tests. The reuse path in `app/api/forms/route.ts` returned the saved Form without rebuilding, as designed.
- **Email block:** our code never sets `emailCollectionType` or any email option. Google reports `DO_NOT_COLLECT` for this Form, so the respondent-email block you saw is not an API setting we control; nothing was changed.
- **Old forms:** `GET/POST /api/forms/identity-fields` + `AddIdentityFieldsButton`. Adds the 4 items via `createItem` at 0-3 only when none exist and zero responses; idempotent; refuses (409) with responses or a partial arrangement; guarded by `requiredRevisionId`. The mlops Form already has 1 response, so it will be refused.
- **Clipboard:** `lib/copy-to-clipboard.ts` (Clipboard API -> hidden textarea + execCommand -> false, never throws), used by both copy buttons; a readonly input shows the link on failure.
- **Logging:** `createGoogleForm` logs request count/types and createItem locations before batchUpdate.

## Per-test results view

- `/dashboard/tests/[id]`: "Responses" table (Name, Roll No, Class, Division, Score / Total, Submitted at), newest first, empty state pointing to Sync scores; shown for published tests; page now returns 404 unless `test.user_id` is the signed-in user.
- `/dashboard/scores`: test dropdown lists the signed-in faculty's own tests (query filtered by `user_id`, includes tests with no scores); count/average (score and %) follow the selected test; "Download CSV" (selected test only, formula-injection-safe) built client-side from the already owner-filtered rows. Existing `tests.user_id` score filter kept.
- Helpers in `lib/scores/results.ts`. DB changes: none.
- Checks: tsc OK, npm test 24/24, eslint clean, build passed. Not exercised in a browser against live data.

## Gemini hardening

- `lib/ai/model.ts`: ordered chain (`GEMINI_MODEL_CHAIN`, names only; default `gemini-3.5-flash`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`: the models that answered for this key, stable before preview; 3.8/3.7-flash hung, 2.x return 404). `lib/ai/model-availability.ts` calls models.list once per 10 min and skips models the key cannot use (list failure = chain unchanged).
- Retries (`runWithFallback`): 503/429/timeout/network and malformed output rotate to the next model with exponential backoff + jitter inside a 100 s per-batch budget (240 s for all batches; route `maxDuration = 300`). 400/401/403/unknown are not retried; 404 skips that model without waiting.
- Distinct safe messages + HTTP status: busy 503, rate limit/quota 429, timeout 504, configuration 503, each with the ref; provider text is never returned.
- Batches of at most 5 questions, merged and de-duplicated; quality, source-ID and provenance checks run per batch. A failed batch fails the request unless `allowPartial: true` (checkbox on the config step); then the finished batches are returned with a notice.
- Generate page keeps the form inputs on error and shows a Retry button.
- Checks: tsc OK, npm test 35/35, eslint clean, build passed. Not exercised against a real Google outage.
