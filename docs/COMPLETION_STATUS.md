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
