-- Save a draft assessment and its questions as one database transaction.
-- The caller must use its authenticated Supabase session; RLS remains enabled.
create or replace function public.save_draft_test(
  p_syllabus_id uuid,
  p_generation_config jsonb,
  p_questions jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_test public.tests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_generation_config is null
     or p_generation_config ->> 'syllabusId' is distinct from p_syllabus_id::text
     or jsonb_typeof(p_questions) is distinct from 'array'
     or jsonb_array_length(p_questions) < 1 then
    raise exception 'Invalid draft payload';
  end if;

  if not exists (
    select 1 from public.syllabi s
    where s.id = p_syllabus_id
      and s.user_id = v_user_id
      and s.status = 'ready'
  ) then
    raise exception 'Syllabus not found or not ready';
  end if;

  insert into public.tests (
    user_id,
    title,
    subject,
    syllabus_text,
    difficulty,
    question_count,
    status,
    syllabus_id,
    generation_config
  ) values (
    v_user_id,
    p_generation_config ->> 'title',
    p_generation_config ->> 'subject',
    '', -- Legacy non-null column; RAG drafts link to syllabi by syllabus_id.
    p_generation_config ->> 'difficulty',
    jsonb_array_length(p_questions),
    'draft',
    p_syllabus_id,
    p_generation_config
  ) returning * into v_test;

  insert into public.questions (
    test_id,
    topic,
    question,
    options,
    correct_answer_index,
    position,
    source_chunk_ids,
    grounding_status,
    validation_status,
    validation_metadata
  )
  select
    v_test.id,
    q.item ->> 'topic',
    q.item ->> 'question',
    q.item -> 'options',
    (q.item ->> 'correctAnswerIndex')::smallint,
    (q.ordinality - 1)::integer,
    '[]'::jsonb,
    'needs_review',
    'not_applicable',
    '{}'::jsonb
  from jsonb_array_elements(p_questions) with ordinality as q(item, ordinality);

  return to_jsonb(v_test);
end;
$$;

revoke all on function public.save_draft_test(uuid, jsonb, jsonb) from public;
grant execute on function public.save_draft_test(uuid, jsonb, jsonb) to authenticated;
