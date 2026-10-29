# TestGenie -- Implementation Roadmap

Handover checklist. Follow in order -- each step depends on the one before.
Full detail for any step is in [README.md](README.md).

## Step 0 -- Prerequisites

- [ ] Node.js 20+ and npm 10+ installed (`node -v`, `npm -v`)
- [ ] A Supabase account (free tier)
- [ ] A Google account for Google Cloud Console (only needed for Forms export)
- [ ] A Gemini API key, or plan to run in mock mode first

## Step 1 -- Get the app running locally (no external accounts yet)

```bash
npm install
cp .env.example .env.local
```

Open `.env.local` and set just this one line, leave everything else blank for now:

```
AI_PROVIDER=mock
```

```bash
npm run dev
```

Open http://localhost:3000. You'll see the landing page. Login/signup will
fail until Step 2 (no Supabase project yet) -- that's expected.

## Step 2 -- Supabase (auth + database)

- [ ] Create a project at https://supabase.com
- [ ] SQL Editor -> paste and run all of `supabase/migrations/001_initial_schema.sql`
- [ ] Authentication -> Providers -> confirm Email is enabled
- [ ] Authentication -> URL Configuration -> add redirect URL
      `http://localhost:3000/auth/callback`
- [ ] Settings -> API -> copy three values into `.env.local`:
      `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
      `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Restart `npm run dev`, sign up a test account, confirm you land on
      `/dashboard` with all four stat cards showing zero

**Checkpoint**: signup, login, logout, and the empty dashboard all work.

## Step 3 -- Try the full flow in mock mode

With `AI_PROVIDER=mock` still set:

- [ ] Dashboard -> Generate Test -> paste any paragraph of text (manual tab)
- [ ] Fill in title/subject, generate questions -- confirm mock questions appear
- [ ] Edit a question, change a correct answer, delete one, add one
- [ ] Save Test -- confirm it appears on `/dashboard/tests`
- [ ] Open the test detail page, confirm Edit Test round-trips changes

**Checkpoint**: the entire syllabus-to-saved-test pipeline works without any
AI or Google cost. This is the fastest way to verify your local setup before
spending API calls.

## Step 4 -- Real AI generation (Gemini)

- [ ] Get a key at https://aistudio.google.com/apikey
- [ ] In `.env.local`: `AI_PROVIDER=gemini`, `GEMINI_API_KEY=...`,
      `GEMINI_MODEL=gemini-2.0-flash`
- [ ] Restart `npm run dev`, repeat Step 3 with a real syllabus PDF upload
      instead of pasted text
- [ ] Try a bad input (empty PDF, scanned image PDF) -- confirm you get a
      readable error, not a crash

**Checkpoint**: PDF upload extracts real text, Gemini returns real questions,
and validation errors show a clear message.

## Step 5 -- Google Forms export

- [ ] Google Cloud Console -> new project -> enable **Google Forms API** and
      **Google Drive API**
- [ ] OAuth consent screen -> External -> add yourself as a test user
- [ ] Create OAuth Client ID (Web application) -> authorized redirect URI
      `http://localhost:3000/api/google/callback`
- [ ] In `.env.local`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
      `GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/callback`
- [ ] Restart, open a saved test's detail page, click **Create Google Form**
- [ ] First time, you'll be sent through Google's consent screen -- approve it
- [ ] Confirm you land back on the test page and "Open Google Form" now works
- [ ] Open the form, confirm it's a Quiz (Settings gear -> Quizzes tab ->
      "Make this a quiz" should already be ON) with correct answers marked

**Checkpoint**: a real Google Form gets created with self-grading enabled.
Known limitation (see README): "collect email" and "release grade" timing
aren't settable via the API -- toggle those manually in the Forms UI once,
if you want them.

## Step 6 -- Scores (implementation present; external setup remains)

The repository includes a Forms-bound Apps Script submit trigger and the
authenticated-secret endpoint `/api/scores/ingest`. The endpoint maps a Form
ID to a published test and upserts by the Google response ID when migration
012's unique index is installed. The dashboard reads saved scores under the
faculty ownership policy.

- [ ] Confirm migration 012 against the intended Supabase project and apply it
      through the reviewed migration workflow.
- [ ] Set `GOOGLE_FORMS_WEBHOOK_SECRET` in the server environment and the
      matching Apps Script Script Properties.
- [ ] Install and authorize the submit trigger on a test Form.
- [ ] Submit an approved test response and verify one score appears in the
      owning faculty dashboard; resend the same response to verify idempotency.

The integration has not been exercised with a real Google response. Do not
write test rows directly into production or treat the local implementation as
verified until these controlled checks pass.

## Step 7 -- Deploy

- [ ] Push to a GitHub repo
- [ ] Import into Vercel, set every variable from `.env.example` in Vercel's
      project settings
- [ ] Update `GOOGLE_REDIRECT_URI` and `NEXT_PUBLIC_APP_URL` to the
      production domain, and add the production callback URL in both the
      Google OAuth client and Supabase's redirect URL list
- [ ] Submit the Google OAuth consent screen for verification (removes the
      "unverified app" warning) once you're past testing

## Where to look when something breaks

| Symptom | Check |
|---|---|
| Login/signup fails | Supabase URL/keys in `.env.local`, redirect URL configured |
| Dashboard redirects to `/login` immediately | `middleware.ts` / cookie session -- check browser cookies aren't blocked |
| "GEMINI_API_KEY is not configured" | Set it, or switch back to `AI_PROVIDER=mock` |
| PDF upload fails | Likely a scanned/image-only PDF -- use the manual text tab |
| "Google account not connected" | Click Create Google Form again -- it redirects through OAuth consent first |
| Google Form created but ungraded | Confirm `quizSettings.isQuiz` -- check `lib/google/forms.ts` |
| RLS "row not found" on another user's data | Working as intended -- RLS scopes every table to `auth.uid()` |
