-- TestGenie initial schema
-- Run this in the Supabase SQL Editor (or `supabase db push`).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- auto-create a profile row when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- tests
-- ---------------------------------------------------------------------------
create table if not exists public.tests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  subject text not null,
  syllabus_text text not null,
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard', 'mixed')),
  question_count integer not null check (question_count between 1 and 50),
  google_form_id text,
  google_form_url text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tests_user_id_idx on public.tests(user_id);

alter table public.tests enable row level security;

create policy "tests_select_own" on public.tests
  for select using (auth.uid() = user_id);

create policy "tests_insert_own" on public.tests
  for insert with check (auth.uid() = user_id);

create policy "tests_update_own" on public.tests
  for update using (auth.uid() = user_id);

create policy "tests_delete_own" on public.tests
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- questions
-- ---------------------------------------------------------------------------
create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,
  topic text not null,
  question text not null,
  options jsonb not null,
  correct_answer_index smallint not null check (correct_answer_index between 0 and 3),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint questions_options_length check (jsonb_array_length(options) = 4)
);

create index if not exists questions_test_id_idx on public.questions(test_id);

alter table public.questions enable row level security;

create policy "questions_select_own" on public.questions
  for select using (
    exists (select 1 from public.tests t where t.id = test_id and t.user_id = auth.uid())
  );

create policy "questions_insert_own" on public.questions
  for insert with check (
    exists (select 1 from public.tests t where t.id = test_id and t.user_id = auth.uid())
  );

create policy "questions_update_own" on public.questions
  for update using (
    exists (select 1 from public.tests t where t.id = test_id and t.user_id = auth.uid())
  );

create policy "questions_delete_own" on public.questions
  for delete using (
    exists (select 1 from public.tests t where t.id = test_id and t.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- scores  (written by the Apps Script / grading webhook, read by faculty)
-- ---------------------------------------------------------------------------
create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,
  student_name text not null,
  student_email text not null,
  score integer not null,
  total_questions integer not null,
  percentage numeric(5, 2) not null,
  submitted_at timestamptz not null default now()
);

create index if not exists scores_test_id_idx on public.scores(test_id);

alter table public.scores enable row level security;

create policy "scores_select_own" on public.scores
  for select using (
    exists (select 1 from public.tests t where t.id = test_id and t.user_id = auth.uid())
  );

-- scores are inserted by the service role (server-side grading webhook), not by end users.

-- ---------------------------------------------------------------------------
-- google_credentials  (per-faculty Google OAuth tokens for the Forms API)
-- ---------------------------------------------------------------------------
create table if not exists public.google_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  scope text not null,
  expiry_date bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_credentials enable row level security;

create policy "google_credentials_select_own" on public.google_credentials
  for select using (auth.uid() = user_id);

-- inserts/updates go through the service role from the OAuth callback route.

-- ---------------------------------------------------------------------------
-- updated_at bookkeeping
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tests_set_updated_at on public.tests;
create trigger tests_set_updated_at
  before update on public.tests
  for each row execute procedure public.set_updated_at();

drop trigger if exists google_credentials_set_updated_at on public.google_credentials;
create trigger google_credentials_set_updated_at
  before update on public.google_credentials
  for each row execute procedure public.set_updated_at();
