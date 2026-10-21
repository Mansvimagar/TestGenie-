-- TestGenie security hardening for draft and published assessments.
-- Apply only after 007_question_explanations_and_quality.sql,
-- 008_review_metadata_and_atomic_question_updates.sql, and
-- 009_publish_reviewed_tests.sql.
--
-- This migration preserves the existing authenticated application paths:
--   * draft save via save_draft_test
--   * edits via update_test_questions and the single-question regenerate route
--   * publication via publish_test
--   * Google Forms metadata updates on google_form_id/google_form_url
--
-- It leaves service_role privileges untouched. RLS remains enabled and the
-- authenticated policies below constrain direct API operations by ownership
-- and draft status.

-- Remove unnecessary grants to the unauthenticated API role and avoid broad
-- table grants for authenticated clients. Regrant only the columns and DML
-- operations used by the current application.
revoke all privileges (
  id, user_id, title, subject, syllabus_text, difficulty, question_count,
  google_form_id, google_form_url, status, created_at, updated_at, syllabus_id,
  generation_config
) on table public.tests from public, anon, authenticated;
revoke all privileges (
  id, test_id, topic, question, options, correct_answer_index, position,
  created_at, source_chunk_ids, grounding_status, validation_status,
  validation_metadata, explanation
) on table public.questions from public, anon, authenticated;
revoke all privileges on table public.tests, public.questions
  from public, anon, authenticated;

grant select, delete on table public.tests to authenticated;
grant insert (
  user_id,
  title,
  subject,
  syllabus_text,
  difficulty,
  question_count,
  status,
  syllabus_id,
  generation_config
) on public.tests to authenticated;
grant update (
  title,
  subject,
  difficulty,
  question_count,
  google_form_id,
  google_form_url
) on public.tests to authenticated;

grant select, delete on table public.questions to authenticated;
grant insert (
  test_id,
  topic,
  question,
  options,
  correct_answer_index,
  position,
  explanation,
  source_chunk_ids,
  grounding_status,
  validation_status,
  validation_metadata
) on public.questions to authenticated;
grant update (
  topic,
  question,
  options,
  correct_answer_index,
  explanation,
  source_chunk_ids,
  grounding_status,
  validation_status,
  validation_metadata
) on public.questions to authenticated;

-- RLS policies are permissive by default and combine with OR. These
-- restrictive policies add an AND condition, so another permissive policy
-- cannot allow an authenticated user to create or delete a published test.
drop policy if exists tests_insert_draft_only on public.tests;
create policy tests_insert_draft_only
  on public.tests as restrictive
  for insert to authenticated
  with check (auth.uid() = user_id and status = 'draft');

drop policy if exists tests_delete_draft_only on public.tests;
create policy tests_delete_draft_only
  on public.tests as restrictive
  for delete to authenticated
  using (auth.uid() = user_id and status = 'draft');

-- Require a draft for every direct question write as well as through the
-- update RPC. Migration 009 replaces the permissive owner policies; these
-- restrictive policies preserve the same rule if another permissive policy
-- is later added.
drop policy if exists questions_insert_draft_only on public.questions;
create policy questions_insert_draft_only
  on public.questions as restrictive
  for insert to authenticated
  with check (
    exists (
      select 1 from public.tests t
      where t.id = test_id and t.user_id = auth.uid() and t.status = 'draft'
    )
  );

drop policy if exists questions_update_draft_only on public.questions;
create policy questions_update_draft_only
  on public.questions as restrictive
  for update to authenticated
  using (
    exists (
      select 1 from public.tests t
      where t.id = test_id and t.user_id = auth.uid() and t.status = 'draft'
    )
  )
  with check (
    exists (
      select 1 from public.tests t
      where t.id = test_id and t.user_id = auth.uid() and t.status = 'draft'
    )
  );

drop policy if exists questions_delete_draft_only on public.questions;
create policy questions_delete_draft_only
  on public.questions as restrictive
  for delete to authenticated
  using (
    exists (
      select 1 from public.tests t
      where t.id = test_id and t.user_id = auth.uid() and t.status = 'draft'
    )
  );

-- Migration 008's function relies on RLS for draft-only question writes but
-- does not check the test status itself. Keep that defense in depth inside
-- the owner-checked atomic RPC too.
create or replace function public.update_test_questions(
  p_test_id uuid,
  p_title text,
  p_subject text,
  p_difficulty text,
  p_questions jsonb
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_test public.tests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if jsonb_typeof(p_questions) is distinct from 'array'
     or jsonb_array_length(p_questions) < 1
     or jsonb_array_length(p_questions) > 50 then
    raise exception 'Invalid question payload';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_questions) as q(item)
    where q.item ? 'sourceChunkIds'
      and jsonb_typeof(q.item -> 'sourceChunkIds') is distinct from 'array'
  ) then
    raise exception 'Invalid question payload';
  end if;

  select * into v_test
  from public.tests t
  where t.id = p_test_id and t.user_id = v_user_id
  for update;

  if not found then
    raise exception 'Test not found';
  end if;
  if v_test.status <> 'draft' then
    raise exception 'Only draft tests can be edited';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_questions) as q(item)
    cross join lateral jsonb_array_elements_text(
      coalesce(q.item -> 'sourceChunkIds', '[]'::jsonb)
    ) as source(chunk_id)
    where v_test.syllabus_id is null or not exists (
      select 1
      from public.syllabus_chunks c
      where c.id::text = source.chunk_id
        and c.syllabus_id = v_test.syllabus_id
        and (nullif(v_test.generation_config ->> 'unit', '') is null
             or c.unit = v_test.generation_config ->> 'unit')
        and (nullif(v_test.generation_config ->> 'topic', '') is null
             or c.topic = v_test.generation_config ->> 'topic')
        and (nullif(v_test.generation_config ->> 'subtopic', '') is null
             or c.subtopic = v_test.generation_config ->> 'subtopic')
        and (not (v_test.generation_config ? 'includedTopics')
             or (v_test.generation_config -> 'includedTopics' ? coalesce(c.topic, '')))
        and not (coalesce(v_test.generation_config -> 'excludedTopics', '[]'::jsonb)
                 ? coalesce(c.topic, ''))
        and c.metadata ->> 'embeddingProvider' = 'gemini'
    )
  ) then
    raise exception 'Source evidence is outside the requested syllabus scope';
  end if;

  update public.tests
  set title = p_title,
      subject = p_subject,
      difficulty = p_difficulty,
      question_count = jsonb_array_length(p_questions)
  where id = p_test_id and user_id = v_user_id and status = 'draft';

  delete from public.questions where test_id = p_test_id;

  insert into public.questions (
    test_id,
    topic,
    question,
    options,
    correct_answer_index,
    position,
    explanation,
    source_chunk_ids,
    grounding_status,
    validation_status,
    validation_metadata
  )
  select
    p_test_id,
    q.item ->> 'topic',
    q.item ->> 'question',
    q.item -> 'options',
    (q.item ->> 'correctAnswerIndex')::smallint,
    (q.ordinality - 1)::integer,
    q.item ->> 'explanation',
    coalesce(q.item -> 'sourceChunkIds', '[]'::jsonb),
    'needs_review',
    coalesce(q.item ->> 'validationStatus', 'not_applicable'),
    coalesce(q.item -> 'validationMetadata', '{}'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality as q(item, ordinality);
end;
$$;

revoke all on function public.update_test_questions(uuid, text, text, text, jsonb)
  from public, anon;
grant execute on function public.update_test_questions(uuid, text, text, text, jsonb)
  to authenticated;

-- Do not allow unauthenticated invocation of draft-save. CREATE OR REPLACE in
-- migrations 007/008 preserves existing per-role grants, so remove anon here.
revoke all on function public.save_draft_test(uuid, jsonb, jsonb)
  from public, anon;
grant execute on function public.save_draft_test(uuid, jsonb, jsonb)
  to authenticated;

revoke all on function public.publish_test(uuid) from public, anon;
grant execute on function public.publish_test(uuid) to authenticated;

-- Harden the SECURITY DEFINER publisher's function-local path. Its referenced
-- application objects are schema-qualified; pg_catalog precedes public.
alter function public.publish_test(uuid)
  set search_path = pg_catalog, public;

-- The trigger function is SECURITY INVOKER, but use the same safe fixed path.
alter function public.prevent_published_test_changes()
  set search_path = pg_catalog, public;
