# TestGenie

AI-powered test generator for faculty. Upload a syllabus, get AI-drafted
multiple-choice questions, review and edit them, then publish a self-grading
Google Form. When the Forms-bound Apps Script and webhook are configured,
graded scores appear in the faculty dashboard.

## Requirements

- Node.js 20+
- npm 10+
- A Supabase project (free tier is fine)
- A Google Cloud project (only needed for Google Forms export)
- A Gemini API key (only needed for real AI generation -- see Mock mode below)

## 1. Install

```bash
npm install
```

## 2. Environment variables

Copy the example env file:

```bash
cp .env.example .env.local
```

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

| Variable | Where to get it | Required |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project -> Settings -> API | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project -> Settings -> API | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project -> Settings -> API (keep secret, server-only) | Yes |
| `AI_PROVIDER` | `gemini` or `mock` | Yes |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey | Only if `AI_PROVIDER=gemini` |
| `GEMINI_MODEL` | e.g. `gemini-2.0-flash` | Only if `AI_PROVIDER=gemini` |
| `GOOGLE_CLIENT_ID` | Google Cloud -> APIs & Services -> Credentials | Only for Google Forms export |
| `GOOGLE_CLIENT_SECRET` | Google Cloud -> APIs & Services -> Credentials | Only for Google Forms export |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/api/google/callback` locally | Only for Google Forms export |
| `GOOGLE_FORMS_WEBHOOK_SECRET` | Generate a private shared secret for the Apps Script score webhook | Only for score ingestion |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` locally | Yes |

Never commit `.env.local`. Nothing prefixed `NEXT_PUBLIC_` should ever hold a secret.
Keep `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, and
`GOOGLE_FORMS_WEBHOOK_SECRET` server-side. Set the webhook secret in the Apps
Script project's Script Properties; never put it in a form response or browser
code.

## 3. Supabase setup

1. Create a project at https://supabase.com.
2. Review the SQL migration history and apply the intended migration set in
   order to a new project. Do not assume the local migration files match an
   existing project's schema. In particular, migrations 012 and 013 are local
   score-idempotency and Google Form retry/credential-ACL candidates; they have
   not been confirmed against or applied to a live project. Before using them
   on an existing project, confirm its project ref and migration history, take
   a recoverable backup, and compare the read-only
   [`preflight_test_workflow_v2.sql`](supabase/repairs/preflight_test_workflow_v2.sql)
   output with the repair candidates. Migration 013 changes browser access to
   `google_credentials`; reconcile it with
   [`google_credentials_access_hotfix.sql`](supabase/repairs/google_credentials_access_hotfix.sql)
   before applying either. Never run the workflow repair candidate as a
   migration or without its documented prerequisites.
3. The initial schema file documents the base tables, but deployment must
   include the approved migrations that define the current application RPCs
   and policies. Check the live schema and grants before enabling draft,
   publish, Forms creation, or score ingestion.
4. In Authentication -> Providers, make sure Email is enabled.
5. In Authentication -> URL Configuration, add `http://localhost:3000/auth/callback`
   as a redirect URL (and your production URL when you deploy).
6. Copy the Project URL, anon key, and service_role key into `.env.local`.

## 4. Gemini setup

1. Get an API key at https://aistudio.google.com/apikey.
2. Set `GEMINI_API_KEY` and `GEMINI_MODEL` (e.g. `gemini-2.0-flash`) in `.env.local`.
3. Set `AI_PROVIDER=gemini`.

### Mock mode

Set `AI_PROVIDER=mock` to generate deterministic placeholder questions with
no API key and no cost, using the exact same `Question` shape the UI
expects. Useful for UI development.

## 5. Google Forms setup

Google Forms export is optional -- without it, tests are still generated,
edited, and saved locally; only the "Create Google Form" step is unavailable.

1. Create a project at https://console.cloud.google.com.
2. Enable the **Google Forms API** and **Google Drive API**.
3. Configure the OAuth consent screen (External is fine for testing; add
   yourself as a test user).
4. Create an OAuth Client ID of type "Web application".
5. Add `http://localhost:3000/api/google/callback` as an authorized redirect URI.
6. Copy the Client ID and Client Secret into `.env.local` as `GOOGLE_CLIENT_ID`
   / `GOOGLE_CLIENT_SECRET`.
7. From the Generate page, click "Connect Google" (shown once you try to
   create a form without a connected account) to grant TestGenie access.
8. TestGenie requests the Forms body and Drive file scopes. The app stores
   OAuth tokens server-side; do not expose them to the browser.

### Known Google Forms API limitation

The Forms API does not expose every setting in the Forms UI. TestGenie sets
`quizSettings.isQuiz = true` and a `grading.correctAnswers` block on every
question in the API request to configure quiz grading. The request has not been
verified against a live Google account. Two things the API does **not** expose,
so they are not faked:

- "Collect email addresses" and "Release grade" timing are not settable via
  the API. After a form is created, open it once in the Google Forms UI and
  turn these on manually if you want them.
- Reading responses is not performed through a Forms polling API in this app.
  The repository includes a Forms-bound Apps Script submit trigger that posts
  graded scores to `/api/scores/ingest`. Configure the webhook secret in server
  deployment and Apps Script properties, install and authorize the trigger for
  each form, and apply the reviewed idempotency migration before relying on
  duplicate-safe ingestion. These external steps have not been verified here.

### Score ingestion setup

1. Configure `GOOGLE_FORMS_WEBHOOK_SECRET` in the server environment and set
   the identical secret plus the `/api/scores/ingest` URL in the form's Apps
   Script Script Properties.
2. Add `scripts/google-forms-score-sync.gs` to the Forms-bound Apps Script
   project and install an on-form-submit trigger for the handler.
3. Authorize the script and verify with an approved test response. Confirm
   respondent email collection in the Form settings if email is needed.
4. Review and apply `supabase/migrations/012_idempotent_google_form_scores.sql`
   only after confirming the intended project's migration state. Without the
   unique index, duplicate-safe upsert is unavailable.

## 6. Local development

```bash
npm run dev
```

Open http://localhost:3000.

## 7. Production build

```bash
npm run build
npm start
```

### Deploying

- **App**: deploy to Vercel, set the same environment variables from
  `.env.example` in the Vercel project settings, and update
  `GOOGLE_REDIRECT_URI` / `NEXT_PUBLIC_APP_URL` to your production domain.
- **Database**: Supabase Cloud (already used in development).
- **Google**: add your production redirect URI to the OAuth client and, once
  verified, submit the OAuth consent screen for verification to remove the
  "unverified app" warning.

## Architecture

- Next.js App Router, TypeScript, Tailwind, all server logic in Route
  Handlers under `app/api/*` -- no separate backend.
- Supabase Postgres + Auth + Row Level Security (`supabase/migrations/001_initial_schema.sql`).
- AI generation in `lib/ai/*`, using the official `@google/genai` SDK with
  structured JSON output, re-validated with Zod (`lib/validation/schemas.ts`)
  before it ever reaches the client.
- PDF parsing in `lib/pdf/parser.ts` (`pdf-parse`), with a manual-paste
  fallback.
- Google Forms integration isolated in `lib/google/*`.

## Zipping the project for distribution

```bash
npm run zip
```

Creates `testgenie-mvp.zip`, excluding `node_modules`, `.next`, `.env*`, and
git metadata.
