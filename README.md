# TestGenie

AI-powered test generator for faculty. Upload a syllabus, get AI-drafted
multiple-choice questions, review and edit them, then publish a self-grading
Google Form -- scores flow back into the dashboard.

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
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` locally | Yes |

Never commit `.env.local`. Nothing prefixed `NEXT_PUBLIC_` should ever hold a secret.

## 3. Supabase setup

1. Create a project at https://supabase.com.
2. Open the SQL Editor and run the full contents of
   [`supabase/migrations/001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql).
   This creates `profiles`, `tests`, `questions`, `scores`, `google_credentials`,
   all indexes, and Row Level Security policies that scope every table to its
   owning faculty member.
3. In Authentication -> Providers, make sure Email is enabled.
4. In Authentication -> URL Configuration, add `http://localhost:3000/auth/callback`
   as a redirect URL (and your production URL when you deploy).
5. Copy the Project URL, anon key, and service_role key into `.env.local`.

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

### Known Google Forms API limitation

The Forms API does not expose every setting in the Forms UI. TestGenie sets
`quizSettings.isQuiz = true` and a `grading.correctAnswers` block on every
question, which is what makes Google Forms auto-grade responses -- this is
fully supported and really happens. Two things the API does **not** expose,
so they are not faked:

- "Collect email addresses" and "Release grade" timing are not settable via
  the API. After a form is created, open it once in the Google Forms UI and
  turn these on manually if you want them.
- Reading response scores back into TestGenie's `scores` table is not part
  of the Forms API itself. Google Forms can send response data to a Google
  Sheet or an Apps Script trigger; wiring a specific export target
  (Sheet, Apps Script webhook, etc.) is a follow-up integration, not
  included in this MVP. The `scores` table and `/dashboard/scores` page are
  ready to receive rows the moment that pipeline is connected.

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
