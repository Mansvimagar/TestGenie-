-- TestGenie Targeted Live Schema Repair & Reconciled RPCs
-- ==============================================================================
-- This script reconciles the verified gaps between the existing live Supabase
-- database and the current TestGenie application code:
--
-- 1. Adds missing columns:
--    - public.questions.explanation (text, nullable)
--    - public.tests.reviewed_by (uuid, references auth.users(id) ON DELETE SET NULL)
--    - public.tests.reviewed_at (timestamptz)
--    - public.scores.google_response_id (text, nullable)
--
-- 2. Adds unique index:
--    - scores_test_google_response_id_uidx on public.scores(test_id, google_response_id)
--      (Ensures idempotent Google Form score ingestion retries)
--
-- 3. Adds Google Form creation coordination:
--    - Table: public.google_form_creation_attempts
--    - RPCs: claim_google_form_creation, record_google_form_creation_form, release_google_form_creation
--
-- 4. Reconciles workflow RPCs (SECURITY DEFINER, strict auth & ownership, fixed search_path):
--    - save_draft_test (persists explanation, source_chunk_ids, validation metadata)
--    - update_test_questions (atomic replacement of draft questions)
--    - replace_test_question (single-question regeneration replacement)
--    - attest_test_review (records explicit faculty review attestation)
--    - assert_test_publishable (verifies review, question count, and grounding)
--    - publish_test (marks test as published)
--
-- 5. Hardens security & ACLs:
--    - Revokes browser-role access to public.google_credentials; grants to service_role
--    - Revokes browser-role access to public.google_form_creation_attempts; grants to service_role
--    - Grants EXECUTE on the authenticated RPCs to authenticated role
--
-- Transactional: any failure rolls back all changes safely.
-- ==============================================================================

begin;

-- ==============================================================================
-- Preflight: Confirm expected base tables and current role capability
-- ==============================================================================
do $preflight$
declare
  v_missing text[];
begin
  if to_regclass('public.tests') is null 
     or to_regclass('public.questions') is null
     or to_regclass('public.scores') is null
     or to_regclass('public.syllabi') is null 
     or to_regclass('public.syllabus_chunks') is null
     or to_regclass('public.google_credentials') is null then
    raise exception 'Preflight failed: Core TestGenie base tables are missing from public schema.';
  end if;

  select array_agg(r.table_name || '.' || r.column_name order by r.table_name, r.column_name)
    into v_missing
  from (values
    ('tests','id'),('tests','user_id'),('tests','title'),('tests','subject'),('tests','syllabus_text'),
    ('tests','difficulty'),('tests','question_count'),('tests','status'),('tests','syllabus_id'),
    ('tests','generation_config'),('tests','google_form_id'),('tests','google_form_url'),
    ('questions','id'),('questions','test_id'),('questions','topic'),('questions','question'),
    ('questions','options'),('questions','correct_answer_index'),('questions','position'),
    ('scores','id'),('scores','test_id'),('scores','score'),('scores','total_questions'),
    ('syllabi','id'),('syllabi','user_id'),('syllabi','status'),
    ('syllabus_chunks','id'),('syllabus_chunks','syllabus_id'),('syllabus_chunks','content')
  ) r(table_name, column_name)
  where not exists(
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = r.table_name and c.column_name = r.column_name
  );

  if v_missing is not null then
    raise exception 'Preflight failed: Required base columns are missing: %', array_to_string(v_missing, ', ');
  end if;
end;
$preflight$;

-- ==============================================================================
-- 1. Table Schema Additions (Idempotent)
-- ==============================================================================

alter table public.questions add column if not exists explanation text;
alter table public.tests add column if not exists reviewed_by uuid;
alter table public.tests add column if not exists reviewed_at timestamptz;

do $review_fk$
begin
  if not exists(
    select 1 from pg_constraint
    where conrelid = 'public.tests'::regclass and conname = 'tests_reviewed_by_fkey'
  ) then
    alter table public.tests add constraint tests_reviewed_by_fkey
      foreign key (reviewed_by) references auth.users(id) on delete set null;
  end if;
end;
$review_fk$;

alter table public.scores add column if not exists google_response_id text;

create unique index if not exists scores_test_google_response_id_uidx
  on public.scores(test_id, google_response_id);

comment on column public.scores.google_response_id is
  'Google Forms response ID used to make score ingestion retries idempotent.';

-- ==============================================================================
-- 2. Google Form Creation Coordination Table
-- ==============================================================================

create table if not exists public.google_form_creation_attempts (
  test_id uuid primary key references public.tests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  lease_token uuid not null,
  lease_expires_at timestamptz not null,
  form_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_form_creation_form_id_format
    check (form_id is null or form_id ~ '^[A-Za-z0-9_-]{10,200}$')
);

-- ==============================================================================
-- 3. Hardening Credentials & Creation Attempt Permissions
-- ==============================================================================

alter table public.google_credentials enable row level security;
drop policy if exists google_credentials_select_own on public.google_credentials;
revoke all privileges on table public.google_credentials from public, anon, authenticated;
grant select, insert, update on public.google_credentials to service_role;

alter table public.google_form_creation_attempts enable row level security;
revoke all privileges on public.google_form_creation_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.google_form_creation_attempts to service_role;

-- ==============================================================================
-- 4. Google Form Creation Coordination RPCs
-- ==============================================================================

create or replace function public.claim_google_form_creation(
  p_test_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_form_id text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from public.tests t
    where t.id = p_test_id and t.user_id = auth.uid() and t.status = 'published'
  ) then
    raise exception 'Published test not found';
  end if;

  insert into public.google_form_creation_attempts as attempt (
    test_id, user_id, lease_token, lease_expires_at
  )
  select t.id, t.user_id, p_lease_token, statement_timestamp() + interval '10 minutes'
  from public.tests t
  where t.id = p_test_id and t.user_id = auth.uid() and t.status = 'published'
  on conflict (test_id) do update
    set lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = statement_timestamp()
    where attempt.lease_expires_at <= statement_timestamp()
  returning attempt.form_id into v_form_id;

  if found then
    return jsonb_build_object('acquired', true, 'formId', v_form_id);
  end if;
  return jsonb_build_object('acquired', false);
end;
$$;

create or replace function public.record_google_form_creation_form(
  p_test_id uuid,
  p_lease_token uuid,
  p_form_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_form_id is null or p_form_id !~ '^[A-Za-z0-9_-]{10,200}$' then
    raise exception 'Invalid Google Form ID';
  end if;

  update public.google_form_creation_attempts
  set form_id = p_form_id, updated_at = statement_timestamp()
  where test_id = p_test_id and user_id = auth.uid() and lease_token = p_lease_token
    and lease_expires_at > statement_timestamp();
  return found;
end;
$$;

create or replace function public.release_google_form_creation(
  p_test_id uuid,
  p_lease_token uuid,
  p_keep_for_recovery boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_keep_for_recovery then
    update public.google_form_creation_attempts
    set lease_expires_at = statement_timestamp(), updated_at = statement_timestamp()
    where test_id = p_test_id and user_id = auth.uid() and lease_token = p_lease_token
      and form_id is not null;
  else
    delete from public.google_form_creation_attempts
    where test_id = p_test_id and user_id = auth.uid() and lease_token = p_lease_token;
  end if;
end;
$$;

revoke all on function public.claim_google_form_creation(uuid, uuid) from public, anon;
grant execute on function public.claim_google_form_creation(uuid, uuid) to authenticated;

revoke all on function public.record_google_form_creation_form(uuid, uuid, text) from public, anon;
grant execute on function public.record_google_form_creation_form(uuid, uuid, text) to authenticated;

revoke all on function public.release_google_form_creation(uuid, uuid, boolean) from public, anon;
grant execute on function public.release_google_form_creation(uuid, uuid, boolean) to authenticated;

-- ==============================================================================
-- 5. Workflow RPCs: Draft Save, Question Edit, Regenerate, Review, and Publish
-- ==============================================================================

create or replace function public.validate_question_provenance()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_syllabus_id uuid;
  v_config jsonb;
begin
  if auth.uid() is null and current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'Authentication required';
  end if;
  if jsonb_typeof(new.source_chunk_ids) is distinct from 'array' then
    raise exception 'Question source IDs must be an array';
  end if;
  if jsonb_array_length(new.source_chunk_ids) = 0 then
    raise exception 'Each saved question requires at least one syllabus source chunk';
  end if;

  select t.syllabus_id, t.generation_config into v_syllabus_id, v_config
  from public.tests t
  where t.id = new.test_id and t.status = 'draft'
    and (t.user_id = auth.uid() or (auth.uid() is null and current_user in ('service_role', 'postgres', 'supabase_admin')))
  for update;

  if not found then
    raise exception 'Draft test not found or not owned by the authenticated user';
  end if;

  if jsonb_typeof(coalesce(v_config, '{}'::jsonb)) is distinct from 'object'
     or v_config->>'syllabusId' is distinct from v_syllabus_id::text
     or (v_config ? 'includedTopics' and jsonb_typeof(v_config->'includedTopics') is distinct from 'array')
     or (v_config ? 'excludedTopics' and jsonb_typeof(v_config->'excludedTopics') is distinct from 'array') then
    raise exception 'Saved test scope is invalid';
  end if;

  if v_syllabus_id is null or not exists (
    select 1 from public.syllabi s
    where s.id = v_syllabus_id
      and s.user_id = (select t.user_id from public.tests t where t.id = new.test_id)
      and s.status = 'ready'
  ) then
    raise exception 'Question source IDs require a linked ready syllabus';
  end if;

  if exists (
    select 1 from jsonb_array_elements_text(new.source_chunk_ids) s(chunk_id)
    where not exists (
      select 1 from public.syllabus_chunks c
      where c.id::text = s.chunk_id
        and c.syllabus_id = v_syllabus_id
        and (nullif(v_config->>'unit', '') is null or c.unit = v_config->>'unit')
        and (nullif(v_config->>'topic', '') is null or c.topic = v_config->>'topic')
        and (nullif(v_config->>'subtopic', '') is null or c.subtopic = v_config->>'subtopic')
        and (jsonb_array_length(coalesce(v_config->'includedTopics', '[]'::jsonb)) = 0 or exists (
          select 1 from jsonb_array_elements_text(coalesce(v_config->'includedTopics', '[]'::jsonb)) i(value)
          where lower(btrim(i.value)) = lower(btrim(coalesce(c.topic, '')))))
        and not exists (
          select 1 from jsonb_array_elements_text(coalesce(v_config->'excludedTopics', '[]'::jsonb)) e(value)
          where lower(btrim(e.value)) = lower(btrim(coalesce(c.topic, ''))))
        and c.metadata->>'embeddingProvider' = 'gemini'
    )
  ) then
    raise exception 'Question source IDs must match Gemini chunks in the saved syllabus scope';
  end if;

  if jsonb_typeof(coalesce(new.validation_metadata, '{}'::jsonb)) is distinct from 'object' then
    raise exception 'Question validation metadata must be an object';
  end if;

  new.grounding_status := 'needs_review';
  new.validation_metadata := (coalesce(new.validation_metadata, '{}'::jsonb)
    - 'supportAssessment' - 'supportReviewNote' - 'groundingSimilarity' - 'groundingStatus' - 'isGrounded' - 'verified')
    || jsonb_build_object('supportAssessment', 'uncertain', 'supportReviewNote', 'Faculty verification required.');
  return new;
end;
$$;

create or replace function public.save_draft_test(
  p_syllabus_id uuid,
  p_generation_config jsonb,
  p_questions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_test public.tests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if jsonb_typeof(p_generation_config) is distinct from 'object'
     or p_generation_config->>'syllabusId' is distinct from p_syllabus_id::text
     or jsonb_typeof(p_questions) is distinct from 'array'
     or jsonb_array_length(p_questions) < 1 or jsonb_array_length(p_questions) > 50 then
    raise exception 'Invalid draft payload';
  end if;
  if (p_generation_config ? 'includedTopics' and jsonb_typeof(p_generation_config->'includedTopics') is distinct from 'array')
     or (p_generation_config ? 'excludedTopics' and jsonb_typeof(p_generation_config->'excludedTopics') is distinct from 'array') then
    raise exception 'Invalid draft scope';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_questions) q(item)
    where jsonb_typeof(q.item) is distinct from 'object'
      or nullif(btrim(q.item->>'topic'), '') is null
      or nullif(btrim(q.item->>'question'), '') is null
      or jsonb_typeof(q.item->'options') is distinct from 'array'
      or case when jsonb_typeof(q.item->'options') = 'array' then jsonb_array_length(q.item->'options') <> 4 else true end
      or jsonb_typeof(q.item->'correctAnswerIndex') is distinct from 'number'
      or case when jsonb_typeof(q.item->'correctAnswerIndex') = 'number' then (q.item->>'correctAnswerIndex')::numeric not in (0, 1, 2, 3) else true end
      or nullif(btrim(q.item->>'explanation'), '') is null
      or case when jsonb_typeof(q.item->'sourceChunkIds') = 'array' then jsonb_array_length(q.item->'sourceChunkIds') = 0 else true end
      or (q.item ? 'validationMetadata' and jsonb_typeof(q.item->'validationMetadata') is distinct from 'object')
  ) then
    raise exception 'Invalid question payload: each question requires 4 options, a valid answer, explanation, and syllabus source chunks';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_questions) q(item)
    cross join lateral (
      select count(distinct lower(btrim(opt.val))) as distinct_opts
      from jsonb_array_elements_text(q.item->'options') opt(val)
      where nullif(btrim(opt.val), '') is not null
    ) counts
    where counts.distinct_opts <> 4
  ) then
    raise exception 'Invalid question options: duplicate or blank options are forbidden';
  end if;

  if not exists (
    select 1 from public.syllabi s
    where s.id = p_syllabus_id and s.user_id = v_user_id and s.status = 'ready'
  ) then
    raise exception 'Ready syllabus not found for this user';
  end if;

  insert into public.tests (
    user_id, syllabus_id, title, subject, syllabus_text, difficulty,
    question_count, status, generation_config
  )
  select
    v_user_id,
    p_syllabus_id,
    coalesce(nullif(btrim(p_generation_config->>'title'), ''), 'Untitled Test'),
    coalesce(nullif(btrim(p_generation_config->>'subject'), ''), 'General'),
    coalesce(s.raw_text, ''),
    case when p_generation_config->>'difficulty' in ('easy', 'medium', 'hard', 'mixed')
      then p_generation_config->>'difficulty' else 'medium' end,
    jsonb_array_length(p_questions),
    'draft',
    p_generation_config
  from public.syllabi s
  where s.id = p_syllabus_id and s.user_id = v_user_id and s.status = 'ready'
  returning * into v_test;

  insert into public.questions (
    test_id, topic, question, options, correct_answer_index, explanation,
    position, source_chunk_ids, grounding_status, validation_status, validation_metadata
  )
  select
    v_test.id,
    btrim(q.item->>'topic'),
    btrim(q.item->>'question'),
    q.item->'options',
    (q.item->>'correctAnswerIndex')::smallint,
    btrim(q.item->>'explanation'),
    (q.ordinality - 1)::integer,
    q.item->'sourceChunkIds',
    'needs_review',
    case when q.item->>'validationStatus' = 'duplicate' then 'duplicate' else 'unique' end,
    coalesce(q.item->'validationMetadata', '{}'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality q(item, ordinality);

  return jsonb_build_object('test', to_jsonb(v_test));
end;
$$;

create or replace function public.update_test_questions(
  p_test_id uuid,
  p_title text,
  p_subject text,
  p_difficulty text,
  p_questions jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_test public.tests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if nullif(btrim(p_title), '') is null or nullif(btrim(p_subject), '') is null then
    raise exception 'Title and subject are required';
  end if;
  if p_difficulty not in ('easy', 'medium', 'hard', 'mixed') then
    raise exception 'Invalid difficulty';
  end if;
  if jsonb_typeof(p_questions) is distinct from 'array'
     or jsonb_array_length(p_questions) < 1 or jsonb_array_length(p_questions) > 50 then
    raise exception 'Invalid questions array';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_questions) q(item)
    where jsonb_typeof(q.item) is distinct from 'object'
      or nullif(btrim(q.item->>'topic'), '') is null
      or nullif(btrim(q.item->>'question'), '') is null
      or jsonb_typeof(q.item->'options') is distinct from 'array'
      or case when jsonb_typeof(q.item->'options') = 'array' then jsonb_array_length(q.item->'options') <> 4 else true end
      or jsonb_typeof(q.item->'correctAnswerIndex') is distinct from 'number'
      or case when jsonb_typeof(q.item->'correctAnswerIndex') = 'number' then (q.item->>'correctAnswerIndex')::numeric not in (0, 1, 2, 3) else true end
      or nullif(btrim(q.item->>'explanation'), '') is null
      or case when jsonb_typeof(q.item->'sourceChunkIds') = 'array' then jsonb_array_length(q.item->'sourceChunkIds') = 0 else true end
  ) then
    raise exception 'Invalid question content: each question must have 4 options, an answer, explanation, and source chunks';
  end if;

  select * into v_test from public.tests
  where id = p_test_id and user_id = v_user_id and status = 'draft'
  for update;

  if not found then
    raise exception 'Draft test not found or not owned by user';
  end if;

  update public.tests
  set title = btrim(p_title),
      subject = btrim(p_subject),
      difficulty = p_difficulty,
      question_count = jsonb_array_length(p_questions),
      reviewed_by = null,
      reviewed_at = null,
      updated_at = statement_timestamp()
  where id = p_test_id;

  delete from public.questions where test_id = p_test_id;

  insert into public.questions (
    test_id, topic, question, options, correct_answer_index, explanation,
    position, source_chunk_ids, grounding_status, validation_status, validation_metadata
  )
  select
    p_test_id,
    btrim(q.item->>'topic'),
    btrim(q.item->>'question'),
    q.item->'options',
    (q.item->>'correctAnswerIndex')::smallint,
    btrim(q.item->>'explanation'),
    (q.ordinality - 1)::integer,
    q.item->'sourceChunkIds',
    'needs_review',
    case when q.item->>'validationStatus' = 'duplicate' then 'duplicate' else 'unique' end,
    coalesce(q.item->'validationMetadata', '{}'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality q(item, ordinality);
end;
$$;

create or replace function public.replace_test_question(
  p_test_id uuid,
  p_question_id uuid,
  p_question jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if jsonb_typeof(p_question) is distinct from 'object'
     or nullif(btrim(p_question->>'topic'), '') is null
     or nullif(btrim(p_question->>'question'), '') is null
     or jsonb_typeof(p_question->'options') is distinct from 'array'
     or case when jsonb_typeof(p_question->'options') = 'array' then jsonb_array_length(p_question->'options') <> 4 else true end
     or jsonb_typeof(p_question->'correctAnswerIndex') is distinct from 'number'
     or case when jsonb_typeof(p_question->'correctAnswerIndex') = 'number' then (p_question->>'correctAnswerIndex')::numeric not in (0, 1, 2, 3) else true end
     or nullif(btrim(p_question->>'explanation'), '') is null
     or case when jsonb_typeof(p_question->'sourceChunkIds') = 'array' then jsonb_array_length(p_question->'sourceChunkIds') = 0 else true end then
    raise exception 'Invalid question payload';
  end if;

  if not exists (
    select 1 from public.tests
    where id = p_test_id and user_id = v_user_id and status = 'draft'
    for update
  ) then
    raise exception 'Draft test not found or not owned by user';
  end if;

  update public.questions
  set topic = btrim(p_question->>'topic'),
      question = btrim(p_question->>'question'),
      options = p_question->'options',
      correct_answer_index = (p_question->>'correctAnswerIndex')::smallint,
      explanation = btrim(p_question->>'explanation'),
      source_chunk_ids = p_question->'sourceChunkIds',
      grounding_status = 'needs_review',
      validation_status = case when p_question->>'validationStatus' = 'duplicate' then 'duplicate' else 'unique' end,
      validation_metadata = coalesce(p_question->'validationMetadata', '{}'::jsonb)
  where id = p_question_id and test_id = p_test_id;

  if not found then
    raise exception 'Target question not found in this draft test';
  end if;

  update public.tests
  set reviewed_by = null,
      reviewed_at = null,
      updated_at = statement_timestamp()
  where id = p_test_id;
end;
$$;

create or replace function public.attest_test_review(p_test_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_test public.tests%rowtype;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_test from public.tests
  where id = p_test_id and user_id = v_user_id and status = 'draft'
  for update;

  if not found then
    raise exception 'Draft test not found or not owned by user';
  end if;

  select count(*) into v_count from public.questions where test_id = p_test_id;
  if v_count < 1 or v_count <> v_test.question_count then
    raise exception 'Question count does not match the test configuration';
  end if;

  if exists (
    select 1 from public.questions
    where test_id = p_test_id
      and (nullif(btrim(explanation), '') is null
           or jsonb_typeof(source_chunk_ids) is distinct from 'array'
           or jsonb_array_length(source_chunk_ids) = 0
           or validation_status = 'duplicate')
  ) then
    raise exception 'Every question must have an explanation, valid source evidence, and no duplicate issues';
  end if;

  update public.tests
  set reviewed_by = v_user_id,
      reviewed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where id = p_test_id;
end;
$$;

create or replace function public.assert_test_publishable(p_test_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_test public.tests%rowtype;
begin
  select * into v_test from public.tests where id = p_test_id;
  if not found then
    raise exception 'Test not found';
  end if;
  if v_test.status <> 'draft' then
    raise exception 'Only draft tests can be published';
  end if;
  if v_test.reviewed_by is null or v_test.reviewed_at is null then
    raise exception 'Test has not received faculty review attestation';
  end if;
  if exists (
    select 1 from public.questions
    where test_id = p_test_id
      and (nullif(btrim(explanation), '') is null
           or jsonb_typeof(source_chunk_ids) is distinct from 'array'
           or jsonb_array_length(source_chunk_ids) = 0)
  ) then
    raise exception 'Every question must have an explanation and source chunks before publishing';
  end if;
end;
$$;

create or replace function public.publish_test(p_test_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1 from public.tests
    where id = p_test_id and user_id = v_user_id and status = 'draft'
    for update
  ) then
    raise exception 'Draft test not found or not owned by user';
  end if;

  perform public.assert_test_publishable(p_test_id);

  update public.tests
  set status = 'published',
      updated_at = statement_timestamp()
  where id = p_test_id and user_id = v_user_id;
end;
$$;

create or replace function public.prevent_published_test_changes()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if old.status = 'published' and (
    new.title is distinct from old.title
    or new.subject is distinct from old.subject
    or new.syllabus_text is distinct from old.syllabus_text
    or new.difficulty is distinct from old.difficulty
    or new.question_count is distinct from old.question_count
    or new.syllabus_id is distinct from old.syllabus_id
    or new.generation_config is distinct from old.generation_config
    or new.status is distinct from old.status
    or new.user_id is distinct from old.user_id
    or new.id is distinct from old.id
  ) then
    raise exception 'Published test content is locked. Modifications to published tests are forbidden.';
  end if;
  return new;
end;
$$;

drop trigger if exists testgenie_protect_published on public.tests;
create trigger testgenie_protect_published
  before update on public.tests
  for each row execute function public.prevent_published_test_changes();

-- ==============================================================================
-- 6. Workflow RPC Grants
-- ==============================================================================

revoke all on function public.save_draft_test(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_draft_test(uuid, jsonb, jsonb) to authenticated;

revoke all on function public.update_test_questions(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.update_test_questions(uuid, text, text, text, jsonb) to authenticated;

revoke all on function public.replace_test_question(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_test_question(uuid, uuid, jsonb) to authenticated;

revoke all on function public.attest_test_review(uuid) from public, anon;
grant execute on function public.attest_test_review(uuid) to authenticated;

revoke all on function public.assert_test_publishable(uuid) from public, anon;
grant execute on function public.assert_test_publishable(uuid) to authenticated;

revoke all on function public.publish_test(uuid) from public, anon;
grant execute on function public.publish_test(uuid) to authenticated;

-- ==============================================================================
-- Postflight Assertions: Fail and roll back if any object is missing
-- ==============================================================================
do $postflight$
declare
  v_missing text[];
begin
  -- 1. Check columns
  select array_agg(r.table_name || '.' || r.column_name) into v_missing
  from (values
    ('questions', 'explanation'),
    ('tests', 'reviewed_by'),
    ('tests', 'reviewed_at'),
    ('scores', 'google_response_id')
  ) r(table_name, column_name)
  where not exists(
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = r.table_name and c.column_name = r.column_name
  );
  if v_missing is not null then
    raise exception 'Postflight failed: Columns missing: %', array_to_string(v_missing, ', ');
  end if;

  -- 2. Check unique index
  if not exists (
    select 1 from pg_class i join pg_namespace n on n.oid = i.relnamespace
    where n.nspname = 'public' and i.relname = 'scores_test_google_response_id_uidx'
  ) then
    raise exception 'Postflight failed: Unique index scores_test_google_response_id_uidx is missing.';
  end if;

  -- 3. Check table
  if to_regclass('public.google_form_creation_attempts') is null then
    raise exception 'Postflight failed: Table public.google_form_creation_attempts is missing.';
  end if;

  -- 4. Check all 9 functions
  if to_regprocedure('public.claim_google_form_creation(uuid,uuid)') is null
     or to_regprocedure('public.record_google_form_creation_form(uuid,uuid,text)') is null
     or to_regprocedure('public.release_google_form_creation(uuid,uuid,boolean)') is null
     or to_regprocedure('public.save_draft_test(uuid,jsonb,jsonb)') is null
     or to_regprocedure('public.update_test_questions(uuid,text,text,text,jsonb)') is null
     or to_regprocedure('public.replace_test_question(uuid,uuid,jsonb)') is null
     or to_regprocedure('public.attest_test_review(uuid)') is null
     or to_regprocedure('public.assert_test_publishable(uuid)') is null
     or to_regprocedure('public.publish_test(uuid)') is null then
    raise exception 'Postflight failed: One or more required RPC functions are missing.';
  end if;

  raise notice 'TestGenie targeted live schema repair completed and verified successfully.';
end;
$postflight$;

commit;
